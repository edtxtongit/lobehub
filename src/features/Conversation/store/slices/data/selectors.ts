import type {
  AssistantContentBlock,
  ChatToolPayloadWithResult,
  UIChatMessage,
} from '@lobechat/types';

import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';

import { type State } from '../../initialState';
import { getPendingInterventions } from './pendingInterventions';
import { getWorkSummariesByRootOperationId } from './workSummaries';

const displayMessages = (s: State) => s.displayMessages;

/**
 * PERF: memoize the id array per displayMessages identity. The selector body
 * ran an O(n) `.map()` allocation on every store notification, and the fresh
 * array forced ChatList's `useShallow` comparator into an element-wise walk
 * each time. With a stable identity the shallow check short-circuits on
 * reference equality. Values are identical — the store contract is immutable
 * updates, so a given displayMessages array always maps to the same ids.
 */
const displayMessageIdsCache = new WeakMap<UIChatMessage[], string[]>();

const displayMessageIds = (s: State): string[] => {
  let ids = displayMessageIdsCache.get(s.displayMessages);
  if (!ids) {
    ids = s.displayMessages.map((m) => m.id);
    displayMessageIdsCache.set(s.displayMessages, ids);
  }
  return ids;
};
const dbMessages = (s: State) => s.dbMessages;
const messagesInit = (s: State) => s.messagesInit;
const skipFetch = (s: State) => s.skipFetch;

/**
 * PERF: `getDisplayMessageById` is subscribed 2-4x per mounted message row,
 * so on EVERY store notification (scroll state writes, streaming writes,
 * activeIndex changes…) the old implementation ran a full O(n) `.find()` scan
 * per subscription — O(rows × messages) per notification, which dominated
 * scroll frame budgets on long topics. A WeakMap-keyed id index rebuilds only
 * when the displayMessages array identity changes (≤ once per streaming
 * commit) and answers lookups in O(1).
 *
 * Precedence is preserved exactly: a top-level message always wins over an
 * agentCouncil member with the same id.
 */
const displayMessageIndexCache = new WeakMap<UIChatMessage[], Map<string, UIChatMessage>>();

const getDisplayMessageIndex = (messages: UIChatMessage[]): Map<string, UIChatMessage> => {
  let index = displayMessageIndexCache.get(messages);
  if (index) return index;

  index = new Map();
  // Pass 1: top-level messages take precedence.
  for (const message of messages) {
    if (!index.has(message.id)) index.set(message.id, message);
  }
  // Pass 2: agentCouncil members are only indexed when no top-level row owns
  // the id (mirrors the original find-then-fallback order).
  for (const message of messages) {
    if (message.role === 'agentCouncil' && (message as any).members) {
      for (const member of (message as any).members as UIChatMessage[]) {
        if (!index.has(member.id)) index.set(member.id, member);
      }
    }
  }

  displayMessageIndexCache.set(messages, index);
  return index;
};

const getDisplayMessageById = (id: string) => (s: State) =>
  getDisplayMessageIndex(s.displayMessages).get(id);

interface DbMessageIndexes {
  byId: Map<string, UIChatMessage>;
  byToolCallId: Map<string, UIChatMessage>;
}

/**
 * Message rows subscribe to these lookups independently. Keep both indexes in
 * one WeakMap entry so a new immutable dbMessages snapshot is scanned once,
 * rather than once per mounted row and selector notification.
 *
 * `byToolCallId` deliberately keeps the first row to preserve Array.find's
 * behavior when an upstream reuses a call id across resumed turns.
 */
const dbMessageIndexCache = new WeakMap<UIChatMessage[], DbMessageIndexes>();

const getDbMessageIndexes = (messages: UIChatMessage[]): DbMessageIndexes => {
  let indexes = dbMessageIndexCache.get(messages);
  if (indexes) return indexes;

  const byId = new Map<string, UIChatMessage>();
  const byToolCallId = new Map<string, UIChatMessage>();
  for (const message of messages) {
    if (!byId.has(message.id)) byId.set(message.id, message);
    if (
      message.tool_call_id !== null &&
      message.tool_call_id !== undefined &&
      !byToolCallId.has(message.tool_call_id)
    ) {
      byToolCallId.set(message.tool_call_id, message);
    }
  }

  indexes = { byId, byToolCallId };
  dbMessageIndexCache.set(messages, indexes);
  return indexes;
};

const getDbMessageById = (id: string) => (s: State) =>
  getDbMessageIndexes(s.dbMessages).byId.get(id);
const getDbMessageByToolCallId = (id: string) => (s: State) =>
  getDbMessageIndexes(s.dbMessages).byToolCallId.get(id);

/**
 * `createdAt` is typed as a number but arrives as a `Date` after a DB rehydrate
 * (superjson keeps `timestamptz` as `Date`), so normalize before comparing.
 */
const toEpochMs = (value: Date | number | string | null | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
};

/**
 * `createdAt` of a tool call's result row, normalized to epoch ms.
 *
 * Resolve the row by its unique message id rather than `tool_call_id`: Codex
 * reuses item ids such as `item_1` across resumed turns in the same topic.
 */
const getToolMessageCreatedAt = (resultMessageId: string | undefined) => (s: State) =>
  resultMessageId ? toEpochMs(getDbMessageById(resultMessageId)(s)?.createdAt) : undefined;

/**
 * Helper to find last message ID in an AssistantContentBlock
 */
const findLastBlockId = (block: AssistantContentBlock | undefined): string | undefined => {
  if (!block) return undefined;

  // Check tools for result message ID
  if (block.tools && block.tools.length > 0) {
    const lastTool = block.tools.at(-1);
    return lastTool?.result_msg_id;
  }

  // Return block ID
  return block.id;
};

/**
 * Recursively finds the last message ID in a message tree
 * Priority: children > tools > self
 */
const findLastMessageIdRecursive = (node: UIChatMessage | undefined): string | undefined => {
  if (!node) return undefined;

  // Priority 1: Dive into children recursively
  if (node.children && node.children.length > 0) {
    const lastChild = node.children.at(-1);
    return findLastBlockId(lastChild);
  }

  // Priority 2: Check tools for result message ID
  if (node.tools && node.tools.length > 0) {
    const lastTool = node.tools.at(-1);
    return lastTool?.result_msg_id;
  }

  // Priority 3: Return self ID
  return node.id;
};

/**
 * Whether a message currently has no reply rendered beneath it.
 *
 * True during the window a retry opens up: `delAndRegenerateMessage` removes the
 * failed turn before the replacement exists, so for a beat the user turn stands
 * alone with nothing under it and nothing to hang a loading state on.
 */
const renderedReplyParentIdsCache = new WeakMap<UIChatMessage[], Set<string>>();

const getRenderedReplyParentIds = (messages: UIChatMessage[]): Set<string> => {
  let parentIds = renderedReplyParentIdsCache.get(messages);
  if (parentIds) return parentIds;

  parentIds = new Set();
  for (const message of messages) {
    if (message.parentId !== null && message.parentId !== undefined) {
      parentIds.add(message.parentId);
    }
  }
  renderedReplyParentIdsCache.set(messages, parentIds);
  return parentIds;
};

const hasNoRenderedReply = (id: string) => (s: State) =>
  !getRenderedReplyParentIds(s.displayMessages).has(id);

/**
 * Finds the last (deepest) message ID from a display message
 * Recursively traverses children and tools to find the actual last message
 */
const findLastMessageId = (id: string) => (s: State) => {
  const message = getDisplayMessageById(id)(s);
  return findLastMessageIdRecursive(message);
};

/**
 * Gets the latest message block from a group message that doesn't contain tools
 * Returns undefined if the last block contains tools or if message is not a group message
 */
const getGroupLatestMessageWithoutTools = (id: string) => (s: State) => {
  const message = s.displayMessages.find((m) => m.id === id);

  if (
    !message ||
    message.role !== 'assistantGroup' ||
    !message.children ||
    message.children.length === 0
  )
    return;

  // Get the last child
  const lastChild = message.children.at(-1);

  if (!lastChild) return;

  // Return the last child only if it doesn't have tools
  if (!lastChild.tools || lastChild.tools.length === 0) {
    if (!lastChild.content) return;

    return lastChild;
  }

  return;
};

// ===== Topic-related selectors (bridged from ChatStore) =====

/**
 * Get the topic summary for current conversation
 * This is a bridge selector that reads from global ChatStore
 */
const currentTopicSummary = () => {
  const chatState = useChatStore.getState();
  return topicSelectors.currentActiveTopicSummary(chatState);
};

const pendingInterventionsCache = new WeakMap<
  UIChatMessage[],
  ReturnType<typeof getPendingInterventions>
>();

const pendingInterventions = (s: State) => {
  let pending = pendingInterventionsCache.get(s.displayMessages);
  if (!pending) {
    pending = getPendingInterventions(s.displayMessages);
    pendingInterventionsCache.set(s.displayMessages, pending);
  }
  return pending;
};

// Works ride the message payload (attached server-side to each round's anchor
// message), so the in-message chips read from the raw `dbMessages` (keyed by the
// display-resolved rootOperationId) instead of a dedicated work-summary fetch.
const workSummariesByRootOperationId = (rootOperationId?: string | null) => (s: State) =>
  getWorkSummariesByRootOperationId(s.dbMessages, rootOperationId);

const isSecondLastMessageFromUser = (s: State) => s.displayMessages.at(-2)?.role === 'user';

const toAssistantContentBlock = (message: UIChatMessage): AssistantContentBlock => ({
  content: message.content,
  error: message.error,
  fileList: message.fileList,
  id: message.id,
  imageList: message.imageList,
  metadata: message.metadata ?? undefined,
  performance: message.performance,
  reasoning: message.reasoning ?? undefined,
  tasks: message.tasks as AssistantContentBlock['tasks'],
  tools: message.tools as ChatToolPayloadWithResult[],
  usage: message.usage,
});

/**
 * Tool subtrees self-subscribe to block fields, often several selectors per
 * mounted row. The old recursive search walked the complete display tree for
 * every selector on every store notification. Build the same depth-first index
 * once per immutable displayMessages snapshot instead.
 *
 * `setBlock` never overwrites: this preserves the original walk's precedence
 * for malformed/legacy payloads that contain duplicate ids (earlier top-level
 * rows, child blocks, task completions, compressed rows, then council members).
 */
const displayBlockIndexCache = new WeakMap<
  UIChatMessage[],
  Map<string, AssistantContentBlock>
>();

const addDisplayBlocks = (
  messages: UIChatMessage[],
  index: Map<string, AssistantContentBlock>,
): void => {
  const setBlock = (block: AssistantContentBlock) => {
    if (!index.has(block.id)) index.set(block.id, block);
  };

  for (const message of messages) {
    if (message.role === 'assistant') setBlock(toAssistantContentBlock(message));

    for (const block of message.children ?? []) setBlock(block);

    // Post-task summaries render after SignalCallbacks but share the same block
    // lookup contract as regular assistant-group children.
    for (const block of
      (message as { taskCompletions?: AssistantContentBlock[] }).taskCompletions ?? []) {
      setBlock(block);
    }

    if (message.compressedMessages) addDisplayBlocks(message.compressedMessages, index);
    if (message.role === 'agentCouncil' && (message as any).members) {
      addDisplayBlocks((message as any).members, index);
    }
  }
};

const getDisplayBlockIndex = (
  messages: UIChatMessage[],
): Map<string, AssistantContentBlock> => {
  let index = displayBlockIndexCache.get(messages);
  if (index) return index;

  index = new Map();
  addDisplayBlocks(messages, index);
  displayBlockIndexCache.set(messages, index);
  return index;
};

const findBlockById = (blockId: string, messages: UIChatMessage[]) =>
  getDisplayBlockIndex(messages).get(blockId);

const getToolsInBlock =
  (blockId: string) =>
  (s: State): ChatToolPayloadWithResult[] | undefined => {
    const block = findBlockById(blockId, s.displayMessages);
    return block?.tools;
  };

const getToolInBlock =
  (blockId: string, toolCallId: string) =>
  (s: State): ChatToolPayloadWithResult | undefined => {
    const tools = getToolsInBlock(blockId)(s);
    return tools?.find((t) => t.id === toolCallId);
  };

const getBlockContent =
  (blockId: string) =>
  (s: State): string | undefined =>
    findBlockById(blockId, s.displayMessages)?.content;

const getBlockHasTools =
  (blockId: string) =>
  (s: State): boolean => {
    const tools = findBlockById(blockId, s.displayMessages)?.tools;
    return !!tools && tools.length > 0;
  };

/**
 * Task ids whose `role='taskCallback'` handoff message already landed in this
 * thread. Drives Goal-card dedupe: once the callback card exists it absorbs
 * the Goal status header, so the creating turn's tracker card retires.
 */
const taskCallbackTaskIdsCache = new WeakMap<UIChatMessage[], string[]>();

const taskCallbackTaskIds = (s: State): string[] => {
  let ids = taskCallbackTaskIdsCache.get(s.displayMessages);
  if (ids) return ids;

  ids = [];
  for (const message of s.displayMessages) {
    if (message.role !== 'taskCallback') continue;
    const taskId = message.metadata?.taskCallback?.taskId;
    if (taskId) ids.push(taskId);
  }
  taskCallbackTaskIdsCache.set(s.displayMessages, ids);
  return ids;
};

/** 1-based position of a verify message among all verify messages in the thread. */
const verifyOrdinalCache = new WeakMap<
  UIChatMessage[],
  { fallback: number; ordinals: Map<string, number> }
>();

const getVerifyOrdinals = (messages: UIChatMessage[]) => {
  let cached = verifyOrdinalCache.get(messages);
  if (cached) return cached;

  const ordinals = new Map<string, number>();
  let ordinal = 0;
  for (const message of messages) {
    if (message.role !== 'verify') continue;
    ordinal += 1;
    // Preserve the first match returned by the old forward scan.
    if (!ordinals.has(message.id)) ordinals.set(message.id, ordinal);
  }

  cached = { fallback: ordinal || 1, ordinals };
  verifyOrdinalCache.set(messages, cached);
  return cached;
};

const getVerifyOrdinal = (id: string) => (s: State) => {
  const { fallback, ordinals } = getVerifyOrdinals(s.displayMessages);
  return ordinals.get(id) ?? fallback;
};

export const dataSelectors = {
  currentTopicSummary,
  dbMessages,
  getVerifyOrdinal,
  displayMessageIds,
  displayMessages,
  findLastMessageId,
  getDbMessageById,
  getDbMessageByToolCallId,
  getBlockContent,
  getBlockHasTools,
  getDisplayMessageById,
  getGroupLatestMessageWithoutTools,
  getToolInBlock,
  getToolMessageCreatedAt,
  getToolsInBlock,
  hasNoRenderedReply,
  isSecondLastMessageFromUser,
  messagesInit,
  pendingInterventions,
  skipFetch,
  taskCallbackTaskIds,
  workSummariesByRootOperationId,
};
