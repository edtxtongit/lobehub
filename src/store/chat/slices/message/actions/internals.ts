import { detectContentOnlyDelta, parse, patchContentInFlatList } from '@lobechat/conversation-flow';
import { type ConversationContext, type TraceEventPayloads } from '@lobechat/types';
import debug from 'debug';
import isEqual from 'fast-deep-equal';

import { traceService } from '@/services/trace';
import { type ChatStore } from '@/store/chat/store';
import { type StoreSetter } from '@/store/types';

import { displayMessageSelectors } from '../../../selectors';
import { pruneContextMaps, trackContextWrite } from '../../../utils/contextCacheEviction';
import { messageMapKey } from '../../../utils/messageMapKey';
import { type MessageDispatch } from '../reducer';
import { messagesReducer } from '../reducer';
import { reconcileAssistantToolLinks } from '../utils/reconcileTools';

const log = debug('lobe-store:message-internals');

/**
 * Internal core methods that serve as building blocks for other actions
 */

type Setter = StoreSetter<ChatStore>;
type MessageDispatchContext = NonNullable<
  Parameters<ChatStore['internal_getConversationContext']>[0]
> & {
  conversationContext?: ConversationContext;
};

export const messageInternals = (set: Setter, get: () => ChatStore, _api?: unknown) =>
  new MessageInternalsActionImpl(set, get, _api);

export class MessageInternalsActionImpl {
  readonly #get: () => ChatStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => ChatStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  internal_dispatchMessage = (payload: MessageDispatch, context?: MessageDispatchContext): void => {
    // Get full conversation context (including scope) from operation or global state
    const ctx =
      context?.conversationContext ?? this.#get().internal_getConversationContext(context);
    log(
      '[internal_dispatchMessage] context: agentId=%s, topicId=%s, threadId=%s, scope=%s',
      ctx.agentId,
      ctx.topicId,
      ctx.threadId,
      ctx.scope,
    );

    const messagesKey = messageMapKey(ctx);

    // Get raw messages from dbMessagesMap and apply reducer
    const rawMessages = this.#get().dbMessagesMap[messagesKey] || [];
    const updatedRawMessages = messagesReducer(rawMessages, payload);

    // Re-link any tool row whose parent assistant lost its tools[] entry — an
    // optimistic updateMessage{tools} on the wrong/old assistant during a step
    // boundary can drop the link while the tool row survives, orphaning the
    // tool bubble. Reconcile on the RAW array so the SoT stays consistent (see
    // reconcileAssistantToolLinks).
    const reconciled = reconcileAssistantToolLinks(updatedRawMessages);

    // PERF: this used to be `isEqual(nextDbMap, dbMessagesMap)` — a deep compare
    // of EVERY loaded topic's full message list, executed on every streaming
    // token, that could never return true while content was growing.
    // Both `messagesReducer` (immer `produce`) and `reconcileAssistantToolLinks`
    // are documented to return the SAME array reference when nothing changed,
    // so a reference check is equivalent and O(1).
    if (reconciled === rawMessages) return;

    trackContextWrite(messagesKey);
    const nextDbMap = { ...this.#get().dbMessagesMap, [messagesKey]: reconciled };

    // PERF: streaming tokens only ever change one message's content/reasoning —
    // never the conversation shape. Detect that case by reference diff and patch
    // the already-parsed flatList in place instead of rebuilding the whole tree
    // (buildHelperMaps -> buildIdTree -> transformAll -> flatten) per token.
    // Falls back to a full parse whenever anything structural moved.
    const delta = detectContentOnlyDelta(rawMessages, reconciled);
    const patched = delta
      ? patchContentInFlatList(this.#get().messagesMap[messagesKey], delta)
      : undefined;

    const flatList = patched ?? parse(reconciled).flatList;
    const nextDisplayMap = { ...this.#get().messagesMap, [messagesKey]: flatList };

    // STABILITY: without a cap these two maps grow with every context the
    // session ever touches (one entry per sub-thread during group runs) until
    // the renderer OOMs. Evicts idle contexts only; see contextCacheEviction.
    const pruned = pruneContextMaps(nextDbMap, nextDisplayMap, messagesKey);

    this.#set(
      { dbMessagesMap: pruned.dbMessagesMap, messagesMap: pruned.messagesMap },
      false,
      {
        payload,
        type: `dispatchMessage/${payload.type}`,
      },
    );
  };

  internal_traceMessage = async (id: string, payload: TraceEventPayloads): Promise<void> => {
    // tracing the diff of update
    const message = displayMessageSelectors.getDisplayMessageById(id)(this.#get());
    if (!message) return;

    const traceId = message?.traceId;
    const observationId = message?.observationId;

    if (traceId && message?.role === 'assistant') {
      traceService
        .traceEvent({ content: message.content, observationId, traceId, ...payload })
        .catch();
    }
  };
}

export type MessageInternalsAction = Pick<
  MessageInternalsActionImpl,
  keyof MessageInternalsActionImpl
>;
