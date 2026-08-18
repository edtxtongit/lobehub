import type { Message } from './types';

/**
 * A content-only streaming delta: the payload that dominates a streaming turn.
 *
 * During token streaming the only things that change on a message are `content`
 * and `reasoning`. Nothing about the conversation SHAPE changes — no new rows,
 * no parent/child edits, no tool links. Yet the display pipeline used to rebuild
 * the entire tree (`buildHelperMaps` -> `buildIdTree` -> `transformAll` ->
 * `flatten`) for every single token, on both stores, which is O(conversation)
 * work per token and the dominant cause of streaming jank in long topics.
 */
export interface ContentOnlyDelta {
  content?: unknown;
  id: string;
  reasoning?: unknown;
  /**
   * Carried so the patched node stays byte-identical to what a full `parse()`
   * would have produced — `messagesReducer` stamps `updatedAt` on every write.
   */
  updatedAt?: unknown;
}

/** Fields whose mutation cannot alter the parsed tree structure. */
const SAFE_MUTABLE_FIELDS = new Set(['content', 'reasoning', 'updatedAt']);

/**
 * Detect — by reference diff — whether `next` differs from `prev` only by the
 * content/reasoning of exactly one message.
 *
 * Reference diffing is what makes this cheap: `messagesReducer` runs through
 * immer's `produce`, so every untouched message keeps its original reference and
 * the scan is a pointer comparison per row. Any structural change (length delta,
 * reordering, new/removed rows, tool-link edits, metadata writes) fails the
 * check and the caller falls back to a full `parse()`.
 *
 * @returns the delta, or `undefined` when a full re-parse is required
 */
export const detectContentOnlyDelta = (
  prev: Message[] | undefined,
  next: Message[] | undefined,
): ContentOnlyDelta | undefined => {
  if (!prev || !next) return;
  if (prev === next) return;
  // A length change means rows appeared or disappeared -> structure changed.
  if (prev.length !== next.length) return;

  let changedIndex = -1;
  for (let i = 0; i < next.length; i++) {
    if (prev[i] === next[i]) continue;
    // More than one row changed -> not a simple streaming delta.
    if (changedIndex >= 0) return;
    changedIndex = i;
  }
  if (changedIndex < 0) return;

  const before = prev[changedIndex] as Record<string, unknown>;
  const after = next[changedIndex] as Record<string, unknown>;
  if (!before || !after) return;
  // Identity must be preserved; a different id at the same slot is a swap.
  if (before.id !== after.id) return;

  // Every field other than the safe set must be referentially identical.
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (SAFE_MUTABLE_FIELDS.has(key)) continue;
    if (before[key] !== after[key]) return;
  }

  // Nothing meaningful actually moved (only `updatedAt` ticked).
  if (before.content === after.content && before.reasoning === after.reasoning) return;

  return {
    content: after.content,
    id: after.id as string,
    reasoning: after.reasoning,
    updatedAt: after.updatedAt,
  };
};

const applyDelta = <T extends object>(node: T, delta: ContentOnlyDelta): T => {
  const next: Record<string, unknown> = { ...node };
  next.content = delta.content;
  // `reasoning` is absent on plain text turns; don't invent the key.
  if ('reasoning' in delta && delta.reasoning !== undefined) next.reasoning = delta.reasoning;
  // Keep the timestamp in lockstep with the raw row the reducer just stamped,
  // otherwise the patched node drifts from the full-parse result.
  if (delta.updatedAt !== undefined && 'updatedAt' in next) next.updatedAt = delta.updatedAt;
  return next as T;
};

/**
 * Apply a content-only delta directly to an already-parsed `flatList`, keeping
 * every untouched node's reference intact.
 *
 * Only the target node — and, when the target is nested, its owning group — get
 * new object identities. That is precisely what React.memo / zustand's
 * `Object.is` / `replaceEqualDeep` need in order to bail out, so a streaming
 * token re-renders exactly one message instead of the whole visible list.
 *
 * Lookup order matters: a virtual `assistantGroup` inherits the id of its first
 * assistant (`{ ...firstAssistant }`) while its own `content` is pinned to `''`
 * and the real text lives in `children[]`. Searching nested slots first prevents
 * writing streamed content onto the group shell.
 *
 * @returns a new flatList, or `undefined` when the node cannot be located
 *   (caller must fall back to a full `parse()`)
 */
export const patchContentInFlatList = (
  flatList: Message[] | undefined,
  delta: ContentOnlyDelta,
): Message[] | undefined => {
  if (!flatList || flatList.length === 0) return;

  // 1. Nested blocks: assistantGroup / supervisor children and task completions.
  for (let i = 0; i < flatList.length; i++) {
    const message = flatList[i] as Message & {
      children?: object[];
      taskCompletions?: object[];
    };

    for (const slot of ['children', 'taskCompletions'] as const) {
      const blocks = message[slot];
      if (!blocks || blocks.length === 0) continue;

      const blockIndex = blocks.findIndex((b) => (b as { id?: string }).id === delta.id);
      if (blockIndex < 0) continue;

      const nextBlocks = blocks.slice();
      nextBlocks[blockIndex] = applyDelta(blocks[blockIndex], delta);

      const nextShell: Record<string, unknown> = { ...message, [slot]: nextBlocks };
      // A virtual group shell is spread from its FIRST assistant row, so it
      // inherits that row's `updatedAt`. When the streamed block is exactly that
      // row, keep the shell's timestamp in lockstep with a full parse. The
      // shell's `content` stays pinned to '' — the text lives in children.
      if (
        message.id === delta.id &&
        delta.updatedAt !== undefined &&
        'updatedAt' in (message as Record<string, unknown>)
      ) {
        nextShell.updatedAt = delta.updatedAt;
      }

      const nextList = flatList.slice();
      nextList[i] = nextShell as Message;
      return nextList;
    }
  }

  // 2. Top-level message that is not a virtual group shell.
  const index = flatList.findIndex((m) => m.id === delta.id);
  if (index >= 0) {
    const target = flatList[index] as Message & { children?: unknown[] };
    const isVirtualShell =
      Array.isArray(target.children) &&
      (target.role === 'assistantGroup' || target.role === 'supervisor');
    // A shell whose block wasn't found above means the structure moved on.
    if (isVirtualShell) return;

    const nextList = flatList.slice();
    nextList[index] = applyDelta(target, delta);
    return nextList;
  }

  return undefined;
};
