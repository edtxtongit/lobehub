import { beforeEach, describe, expect, it } from 'vitest';

import type { UIChatMessage } from '@lobechat/types';

import {
  __resetContextCacheTrackingForTests,
  pruneContextMaps,
  trackContextWrite,
} from '../contextCacheEviction';

const rows = (id: string): UIChatMessage[] =>
  [{ content: `msg of ${id}`, id: `${id}-m1`, role: 'user' }] as unknown as UIChatMessage[];

describe('contextCacheEviction', () => {
  beforeEach(() => {
    __resetContextCacheTrackingForTests();
  });

  it('keeps maps untouched while under the cap', () => {
    const keys = Array.from({ length: 5 }, (_, i) => `ctx-${i}`);
    for (const key of keys) trackContextWrite(key);

    const dbMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));
    const displayMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));

    const result = pruneContextMaps(dbMap, displayMap, 'ctx-0');
    expect(result.dbMessagesMap).toBe(dbMap);
    expect(result.messagesMap).toBe(displayMap);
  });

  it('evicts least-recently-written contexts beyond the cap but never the active one', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `ctx-${i}`);
    for (const key of keys) trackContextWrite(key);

    const dbMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));
    const displayMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));

    // Refresh an OLD key so it must survive, and write via the newest key.
    trackContextWrite('ctx-1');

    const { dbMessagesMap, messagesMap } = pruneContextMaps(dbMap, displayMap, 'ctx-19');

    expect(Object.keys(dbMessagesMap).length).toBe(12);
    expect(Object.keys(messagesMap).length).toBe(12);
    expect(dbMessagesMap['ctx-19']).toBeDefined(); // active key kept
    expect(dbMessagesMap['ctx-1']).toBeDefined(); // refreshed key kept
    expect(dbMessagesMap['ctx-0']).toBeUndefined(); // oldest evicted
    expect(messagesMap['ctx-0']).toBeUndefined(); // evicted from BOTH maps
  });

  it('a streaming context that keeps writing is never evicted', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `ctx-${i}`);
    for (const key of keys) trackContextWrite(key);

    // 20 newer contexts arrive (group orchestration sub-threads), while
    // ctx-0 keeps streaming tokens the whole time.
    for (let i = 12; i < 32; i++) {
      const key = `ctx-${i}`;
      trackContextWrite(key);
      trackContextWrite('ctx-0');
    }

    const all = [...keys, ...Array.from({ length: 20 }, (_, i) => `ctx-${i + 12}`)];
    const dbMap = Object.fromEntries(all.map((k) => [k, rows(k)]));
    const displayMap = Object.fromEntries(all.map((k) => [k, rows(k)]));

    const { dbMessagesMap } = pruneContextMaps(dbMap, displayMap, 'ctx-31');
    expect(dbMessagesMap['ctx-0']).toBeDefined();
    expect(Object.keys(dbMessagesMap).length).toBe(12);
  });

  it('evicted keys can come back and stay warm once written again', () => {
    const keys = Array.from({ length: 13 }, (_, i) => `ctx-${i}`);
    for (const key of keys) trackContextWrite(key);
    const dbMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));
    const displayMap = Object.fromEntries(keys.map((k) => [k, rows(k)]));

    const first = pruneContextMaps(dbMap, displayMap, 'ctx-12');
    expect(first.dbMessagesMap['ctx-0']).toBeUndefined();

    // User revisits ctx-0 later: it is rehydrated and written again.
    trackContextWrite('ctx-0');
    const revivedDb = { ...first.dbMessagesMap, 'ctx-0': rows('ctx-0') };
    const revivedDisplay = { ...first.messagesMap, 'ctx-0': rows('ctx-0') };

    const second = pruneContextMaps(revivedDb, revivedDisplay, 'ctx-0');
    expect(second.dbMessagesMap['ctx-0']).toBeDefined();
    expect(Object.keys(second.dbMessagesMap).length).toBe(12);
  });
});
