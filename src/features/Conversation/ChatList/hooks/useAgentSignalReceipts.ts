import type { UIChatMessage } from '@lobechat/types';
import { useMemo, useRef } from 'react';
import useSWR from 'swr';

import { agentSignalKeys } from '@/libs/swr/keys';
import { agentSignalService } from '@/services/agentSignal';

/** Poll cadence for the active conversation's Agent Signal receipt surface. */
const AGENT_SIGNAL_RECEIPT_INITIAL_REFRESH_INTERVAL_MS = 3000;

/** Upper bound for one backoff sleep so the receipt surface still catches late async work. */
const AGENT_SIGNAL_RECEIPT_MAX_REFRESH_INTERVAL_MS = 60_000;

/** Maximum time to wait for async Agent Signal receipts in the current agent/topic scope. */
const AGENT_SIGNAL_RECEIPT_POLLING_TIMEOUT_MS = 5 * 60_000;

export type AgentSignalReceiptView = Awaited<
  ReturnType<typeof agentSignalService.listReceipts>
>['receipts'][number];

const EMPTY_RECEIPTS: AgentSignalReceiptView[] = [];
const EMPTY_RECEIPTS_BY_ANCHOR = new Map<string, AgentSignalReceiptView[]>();

/**
 * Keep the map identity stable when streaming only changes message content.
 * ChatList closes over this map in its item renderer; returning a fresh but
 * equivalent Map would invalidate VirtualizedList.memo and re-render every
 * mounted row for an unrelated token update.
 */
const receiptGroupsEqual = (
  left: Map<string, AgentSignalReceiptView[]>,
  right: Map<string, AgentSignalReceiptView[]>,
): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;

  for (const [anchor, leftReceipts] of left) {
    const rightReceipts = right.get(anchor);
    if (!rightReceipts || leftReceipts.length !== rightReceipts.length) return false;
    for (let i = 0; i < leftReceipts.length; i++) {
      if (leftReceipts[i] !== rightReceipts[i]) return false;
    }
  }
  return true;
};

export const useAgentSignalReceipts = (input: {
  agentId?: string | null;
  displayMessages: UIChatMessage[];
  enabled?: boolean;
  pollingSignal?: string | null;
  topicId?: string | null;
}) => {
  // TODO: Migrate Agent Signal receipt visibility to a dedicated product capability flag.
  const shouldFetch = input.enabled === true && Boolean(input.agentId && input.topicId);
  const scopeKey = shouldFetch ? `${input.agentId}:${input.topicId}` : undefined;
  const pollingKey = shouldFetch ? `${scopeKey}:${input.pollingSignal ?? ''}` : undefined;
  const pollingKeyRef = useRef<string | undefined>(undefined);
  const scopeKeyRef = useRef<string | undefined>(undefined);
  const latestCreatedAtRef = useRef<number | undefined>(undefined);
  const pollingRef = useRef<{ emptyRefreshes: number; startedAt?: number }>({ emptyRefreshes: 0 });
  const receiptsRef = useRef<AgentSignalReceiptView[]>([]);

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    latestCreatedAtRef.current = undefined;
    receiptsRef.current = [];
  }

  if (pollingKeyRef.current !== pollingKey) {
    pollingKeyRef.current = pollingKey;
    pollingRef.current = {
      emptyRefreshes: 0,
      ...(shouldFetch ? { startedAt: Date.now() } : {}),
    };
  }

  const { data, isLoading } = useSWR(
    shouldFetch ? agentSignalKeys.receipts(input.agentId!, input.topicId!) : null,
    async () => {
      const result = await agentSignalService.listReceipts({
        agentId: input.agentId!,
        limit: 20,
        ...(latestCreatedAtRef.current === undefined
          ? {}
          : { sinceCreatedAt: latestCreatedAtRef.current }),
        topicId: input.topicId!,
      });

      const nextReceipts =
        latestCreatedAtRef.current === undefined
          ? result.receipts
          : mergeReceiptRefresh(receiptsRef.current, result.receipts);
      const latestCreatedAt = nextReceipts[0]?.createdAt;

      receiptsRef.current = nextReceipts;
      latestCreatedAtRef.current =
        latestCreatedAt === undefined ? latestCreatedAtRef.current : latestCreatedAt;
      pollingRef.current.emptyRefreshes =
        result.receipts.length === 0 ? pollingRef.current.emptyRefreshes + 1 : 0;

      return {
        ...result,
        receipts: nextReceipts,
      };
    },
    {
      refreshInterval: () => {
        if (!shouldFetch || pollingRef.current.startedAt === undefined) return 0;

        const elapsedMs = Date.now() - pollingRef.current.startedAt;
        const remainingMs = AGENT_SIGNAL_RECEIPT_POLLING_TIMEOUT_MS - elapsedMs;

        if (remainingMs <= 0) return 0;

        const emptyRefreshBackoffStep = Math.max(pollingRef.current.emptyRefreshes - 1, 0);
        const nextIntervalMs = Math.min(
          AGENT_SIGNAL_RECEIPT_INITIAL_REFRESH_INTERVAL_MS * 2 ** emptyRefreshBackoffStep,
          AGENT_SIGNAL_RECEIPT_MAX_REFRESH_INTERVAL_MS,
        );

        return Math.min(nextIntervalMs, remainingMs);
      },
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    },
  );

  const receipts = data?.receipts ?? EMPTY_RECEIPTS;
  const previousReceiptsByAnchorRef = useRef(EMPTY_RECEIPTS_BY_ANCHOR);

  const receiptsByAnchor = useMemo(() => {
    if (!shouldFetch || receipts.length === 0) {
      previousReceiptsByAnchorRef.current = EMPTY_RECEIPTS_BY_ANCHOR;
      return EMPTY_RECEIPTS_BY_ANCHOR;
    }

    const next = groupAgentSignalReceiptsByEffectiveAnchor({
      displayMessages: input.displayMessages,
      receipts,
    });
    const previous = previousReceiptsByAnchorRef.current;
    if (receiptGroupsEqual(previous, next)) return previous;

    previousReceiptsByAnchorRef.current = next;
    return next;
  }, [input.displayMessages, receipts, shouldFetch]);

  return {
    isLoading,
    receiptsByAnchor,
  };
};

interface GroupAgentSignalReceiptsByEffectiveAnchorInput {
  displayMessages: UIChatMessage[];
  receipts: AgentSignalReceiptView[];
}

const resolveAssistantReplyFromTrigger = (
  triggerMessageId: string | undefined,
  displayMessages: UIChatMessage[],
) => {
  if (!triggerMessageId) return undefined;

  return displayMessages.find(
    (message) =>
      (message.role === 'assistant' || message.role === 'assistantGroup') &&
      message.parentId === triggerMessageId,
  )?.id;
};

const resolveDisplayedAnchorMessageId = (
  anchorMessageId: string,
  displayMessages: UIChatMessage[],
) => {
  if (displayMessages.some((message) => message.id === anchorMessageId)) return anchorMessageId;

  return displayMessages.find(
    (message) =>
      message.role === 'assistantGroup' &&
      message.children?.some((block) => block.id === anchorMessageId),
  )?.id;
};

const resolveEffectiveAnchorMessageId = (
  receipt: AgentSignalReceiptView,
  displayMessages: UIChatMessage[],
) => {
  if (receipt.anchorMessageId) {
    return resolveDisplayedAnchorMessageId(receipt.anchorMessageId, displayMessages);
  }
  if (!receipt.triggerMessageId) return undefined;

  const assistantReplyId = resolveAssistantReplyFromTrigger(
    receipt.triggerMessageId,
    displayMessages,
  );
  if (assistantReplyId) return assistantReplyId;

  // Display fallback belongs here, not in the persisted receipt. A trigger-only
  // receipt tells us why the signal fired; the UI can attach it to the assistant
  // reply when that row exists, or keep it visible on the triggering user message
  // while the assistant row is still unavailable.
  return receipt.triggerMessageId;
};

const groupAgentSignalReceiptsByEffectiveAnchor = ({
  displayMessages,
  receipts,
}: GroupAgentSignalReceiptsByEffectiveAnchorInput) => {
  const receiptsByAnchor = new Map<string, AgentSignalReceiptView[]>();

  for (const receipt of receipts) {
    const anchorMessageId = resolveEffectiveAnchorMessageId(receipt, displayMessages);
    if (!anchorMessageId) continue;

    receiptsByAnchor.set(anchorMessageId, [
      ...(receiptsByAnchor.get(anchorMessageId) ?? []),
      receipt,
    ]);
  }

  return receiptsByAnchor;
};

const mergeReceiptRefresh = (
  currentReceipts: AgentSignalReceiptView[],
  newReceipts: AgentSignalReceiptView[],
) => {
  if (newReceipts.length === 0) return currentReceipts;

  const mergedById = new Map(currentReceipts.map((receipt) => [receipt.id, receipt]));

  for (const receipt of newReceipts) {
    mergedById.set(receipt.id, receipt);
  }

  return [...mergedById.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
};
