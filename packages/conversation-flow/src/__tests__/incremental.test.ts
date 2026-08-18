import { describe, expect, it } from 'vitest';

import { detectContentOnlyDelta, patchContentInFlatList } from '../incremental';
import { parse } from '../parse';
import type { Message } from '../types';

const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();

const msg = (i: number, extra: Partial<Message> & Record<string, any> = {}): any => ({
  agentId: 'agent-1',
  content: `body ${i}`,
  createdAt: at(i),
  id: `msg-${i}`,
  parentId: i === 0 ? null : `msg-${i - 1}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  sessionId: 's1',
  topicId: 't1',
  updatedAt: at(i),
  ...extra,
});

/** Mirror of messagesReducer's immer behaviour: untouched rows keep identity. */
const applyContent = (rows: any[], id: string, content: string, reasoning?: any) =>
  rows.map((m) => {
    if (m.id !== id) return m;
    const next = { ...m, content, updatedAt: at(999) };
    if (reasoning !== undefined) next.reasoning = reasoning;
    return next;
  });

/**
 * The core invariant: the incremental path must produce a flatList that is
 * DEEP-EQUAL to what a full parse() would produce. Anything else means the UI
 * would show stale or corrupted content.
 */
const expectEquivalentToFullParse = (prevRows: any[], nextRows: any[]) => {
  const prevFlat = parse(prevRows).flatList;
  const delta = detectContentOnlyDelta(prevRows, nextRows);
  expect(delta, 'expected a content-only delta to be detected').toBeDefined();

  const patched = patchContentInFlatList(prevFlat, delta!);
  expect(patched, 'expected the delta to be locatable in the flatList').toBeDefined();

  const fullyParsed = parse(nextRows).flatList;
  expect(patched).toEqual(fullyParsed);
  return { fullyParsed, patched: patched!, prevFlat };
};

describe('detectContentOnlyDelta', () => {
  it('detects a single message content change', () => {
    const prev = [msg(0), msg(1)];
    const next = applyContent(prev, 'msg-1', 'streaming text');
    expect(detectContentOnlyDelta(prev, next)).toEqual({
      content: 'streaming text',
      id: 'msg-1',
      reasoning: undefined,
      updatedAt: at(999),
    });
  });

  it('detects reasoning changes alongside content', () => {
    const prev = [msg(0), msg(1)];
    const next = applyContent(prev, 'msg-1', 'text', { content: 'thinking...' });
    const delta = detectContentOnlyDelta(prev, next);
    expect(delta?.reasoning).toEqual({ content: 'thinking...' });
  });

  describe('falls back (returns undefined) on structural change', () => {
    it('row appended', () => {
      const prev = [msg(0), msg(1)];
      expect(detectContentOnlyDelta(prev, [...prev, msg(2)])).toBeUndefined();
    });

    it('row removed', () => {
      const prev = [msg(0), msg(1)];
      expect(detectContentOnlyDelta(prev, [prev[0]])).toBeUndefined();
    });

    it('two messages changed at once', () => {
      const prev = [msg(0), msg(1), msg(2)];
      let next = applyContent(prev, 'msg-1', 'a');
      next = applyContent(next, 'msg-2', 'b');
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('tools[] mutated (tool-link / grouping change)', () => {
      const prev = [msg(0), msg(1)];
      const next = prev.map((m) =>
        m.id === 'msg-1'
          ? { ...m, tools: [{ apiName: 'x', arguments: '{}', id: 'c1', identifier: 'p', type: 'default' }] }
          : m,
      );
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('metadata mutated (can flip scope / supervisor / usage promotion)', () => {
      const prev = [msg(0), msg(1)];
      const next = prev.map((m) => (m.id === 'msg-1' ? { ...m, metadata: { isSupervisor: true } } : m));
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('parentId re-pointed', () => {
      const prev = [msg(0), msg(1)];
      const next = prev.map((m) => (m.id === 'msg-1' ? { ...m, parentId: null } : m));
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('role changed', () => {
      const prev = [msg(0), msg(1)];
      const next = prev.map((m) => (m.id === 'msg-1' ? { ...m, role: 'tool' } : m));
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('id swapped at the same slot', () => {
      const prev = [msg(0), msg(1)];
      const next = [prev[0], { ...prev[1], id: 'other' }];
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('only updatedAt ticked (no visible change)', () => {
      const prev = [msg(0), msg(1)];
      const next = prev.map((m) => (m.id === 'msg-1' ? { ...m, updatedAt: at(999) } : m));
      expect(detectContentOnlyDelta(prev, next)).toBeUndefined();
    });

    it('identical arrays', () => {
      const prev = [msg(0), msg(1)];
      expect(detectContentOnlyDelta(prev, prev)).toBeUndefined();
    });
  });
});

describe('patchContentInFlatList — equivalence with full parse()', () => {
  it('plain streaming assistant at the tail', () => {
    const prev = [msg(0), msg(1), msg(2), msg(3, { content: '' })];
    const next = applyContent(prev, 'msg-3', 'Hello, streaming world');
    expectEquivalentToFullParse(prev, next);
  });

  it('assistant streaming AFTER a tool call (nested in assistantGroup.children)', () => {
    const prev = [
      msg(0),
      msg(1, {
        role: 'assistant',
        tools: [{ apiName: 'search', arguments: '{}', id: 'call-1', identifier: 'web', type: 'default' }],
      }),
      msg(2, { content: 'tool output', parentId: 'msg-1', role: 'tool', tool_call_id: 'call-1' }),
      msg(3, { content: '', parentId: 'msg-2', role: 'assistant' }),
    ];
    const next = applyContent(prev, 'msg-3', 'post-tool answer streaming');

    // Guard the premise: this really is the nested/grouped shape.
    const flat = parse(prev).flatList as any[];
    expect(flat.some((m) => m.role === 'assistantGroup')).toBe(true);
    expect(flat.some((m) => m.id === 'msg-3')).toBe(false);

    expectEquivalentToFullParse(prev, next);
  });

  it('never writes streamed content onto the assistantGroup shell', () => {
    // The group inherits the FIRST assistant's id while its own content stays ''.
    const prev = [
      msg(0),
      msg(1, {
        content: '',
        role: 'assistant',
        tools: [{ apiName: 'search', arguments: '{}', id: 'call-1', identifier: 'web', type: 'default' }],
      }),
      msg(2, { content: 'tool output', parentId: 'msg-1', role: 'tool', tool_call_id: 'call-1' }),
    ];
    const next = applyContent(prev, 'msg-1', 'text streamed before the tool ran');

    const { patched } = expectEquivalentToFullParse(prev, next);
    const shell = (patched as any[]).find((m) => m.role === 'assistantGroup');
    expect(shell.content).toBe('');
    expect(shell.children[0].content).toBe('text streamed before the tool ran');
  });

  it('multi-token streaming stays equivalent at every step', () => {
    let rows: any[] = [msg(0), msg(1), msg(2), msg(3, { content: '' })];
    let flat = parse(rows).flatList;
    let text = '';

    for (const token of ['The ', 'quick ', 'brown ', 'fox ', 'jumps']) {
      text += token;
      const nextRows = applyContent(rows, 'msg-3', text);
      const delta = detectContentOnlyDelta(rows, nextRows)!;
      expect(delta).toBeDefined();

      const patched = patchContentInFlatList(flat, delta)!;
      expect(patched).toBeDefined();
      expect(patched).toEqual(parse(nextRows).flatList);

      rows = nextRows;
      flat = patched;
    }
    expect((flat as any[]).at(-1)!.content).toBe('The quick brown fox jumps');
  });

  it('preserves references for every untouched node (memo bailout)', () => {
    const prev = [msg(0), msg(1), msg(2), msg(3, { content: '' })];
    const next = applyContent(prev, 'msg-3', 'only I changed');
    const { patched, prevFlat } = expectEquivalentToFullParse(prev, next);

    let reused = 0;
    for (let i = 0; i < prevFlat.length - 1; i++) {
      if (prevFlat[i] === patched[i]) reused++;
    }
    expect(reused).toBe(prevFlat.length - 1);
    // The streamed node itself must be a NEW object so subscribers update.
    expect(patched.at(-1)).not.toBe(prevFlat.at(-1));
  });

  it('returns undefined when the target id is absent from the flatList', () => {
    const flat = parse([msg(0), msg(1)]).flatList;
    expect(patchContentInFlatList(flat, { content: 'x', id: 'ghost' })).toBeUndefined();
  });

  it('returns undefined for an empty or missing flatList', () => {
    expect(patchContentInFlatList([], { content: 'x', id: 'msg-1' })).toBeUndefined();
    expect(patchContentInFlatList(undefined, { content: 'x', id: 'msg-1' })).toBeUndefined();
  });
});
