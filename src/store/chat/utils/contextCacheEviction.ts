import { type UIChatMessage } from '@lobechat/types';

/**
 * STABILITY: `dbMessagesMap` and `messagesMap` retain EVERY conversation
 * context the session has ever touched — raw rows plus the parsed flatList
 * (which is larger than the raw rows) — and nothing ever pruned them. A long
 * browsing session grows renderer memory without bound until the tab crashes.
 * Group orchestration makes it worse: every sub-thread context gets its own
 * entry per turn.
 *
 * Policy: track write recency per context key and evict the
 * least-recently-written contexts beyond MAX_ACTIVE_CONTEXTS.
 *
 * Why this is safe:
 * - the key being written right now is always kept;
 * - an actively streaming / orchestrating context refreshes its own timestamp
 *   on every write, so live conversations are never dropped;
 * - a re-visited context is rehydrated from the SWR/IndexedDB message cache
 *   (see `writeThroughMessageCache` in actions/query.ts), so eviction costs a
 *   re-parse at worst, never data loss.
 */

const MAX_ACTIVE_CONTEXTS = 12;

/** Monotonic logical clock — avoids Date.now() churn on the streaming path. */
let clock = 0;
const lastWriteAt = new Map<string, number>();

/** Record a write for `key` so the key stays warm in the LRU. */
export const trackContextWrite = (key: string): void => {
  lastWriteAt.set(key, ++clock);
};

const collectDoomedKeys = (activeKey: string): string[] => {
  if (lastWriteAt.size <= MAX_ACTIVE_CONTEXTS) return [];

  const doomed = [...lastWriteAt.entries()]
    .filter(([key]) => key !== activeKey)
    .sort((a, b) => a[1] - b[1])
    .slice(0, lastWriteAt.size - MAX_ACTIVE_CONTEXTS)
    .map(([key]) => key);

  for (const key of doomed) lastWriteAt.delete(key);
  return doomed;
};

export interface ContextMapsPruneResult {
  dbMessagesMap: Record<string, UIChatMessage[]>;
  messagesMap: Record<string, UIChatMessage[]>;
}

/**
 * Evict stale contexts from BOTH maps consistently (same doomed key set for
 * both, so `dbMessagesMap` and `messagesMap` never drift apart).
 *
 * Returns the input references untouched when nothing needs eviction — the
 * streaming hot path must not pay for an allocation it doesn't need.
 */
export const pruneContextMaps = (
  dbMessagesMap: Record<string, UIChatMessage[]>,
  messagesMap: Record<string, UIChatMessage[]>,
  activeKey: string,
): ContextMapsPruneResult => {
  const doomed = collectDoomedKeys(activeKey);
  if (!doomed.length) return { dbMessagesMap, messagesMap };

  const nextDbMap = { ...dbMessagesMap };
  const nextDisplayMap = { ...messagesMap };
  for (const key of doomed) {
    delete nextDbMap[key];
    delete nextDisplayMap[key];
  }
  return { dbMessagesMap: nextDbMap, messagesMap: nextDisplayMap };
};

/** Test-only: reset the LRU bookkeeping between test cases. */
export const __resetContextCacheTrackingForTests = (): void => {
  clock = 0;
  lastWriteAt.clear();
};
