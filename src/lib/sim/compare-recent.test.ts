import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PINNED, MAX_RECENT, forget, isCurrent, loadSaved, order, remember, savedStorageKey, setPinned, type SavedComparison } from '@/lib/sim/compare-recent';

const info = (n: number) => ({ track: 'Monza', aLap: n, aMs: 100_000 + n, bLap: 5, bMs: 99_000 });
const item = (a: string, b: string | null = null, n = 1) => ({ a, b, info: info(n) });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('remember', () => {
  it('keeps a comparison for this person, newest first', () => {
    let list = remember('ana', [], item('a1', 'b1'), 1000);
    list = remember('ana', list, item('a2', null), 2000);
    expect(list.map((entry) => entry.a)).toEqual(['a2', 'a1']);
    expect(loadSaved('ana').map((entry) => entry.a)).toEqual(['a2', 'a1']);
    expect(loadSaved('bia')).toEqual([]); // another person on the same browser sees nothing of it
    expect(localStorage.getItem(savedStorageKey('ana'))).toBeTruthy();
  });

  it('moves a comparison that is shown again to the front instead of listing it twice, and keeps it saved if it was', () => {
    let list = remember(null, [], item('a1', 'b1'), 1000);
    list = setPinned(null, list, item('a1', 'b1'), true);
    list = remember(null, list, item('a2'), 2000);
    list = remember(null, list, item('a1', 'b1', 7), 3000);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ a: 'a1', pinned: true, at: 3000, info: info(7) });
  });

  it('tells a comparison against the personal best (no reference) from one against a lap', () => {
    const list = remember('ana', remember('ana', [], item('a1', null), 1), item('a1', 'b1'), 2);
    expect(list).toHaveLength(2);
  });

  it('keeps only the latest few recent comparisons, but every saved one up to its own limit', () => {
    let list: SavedComparison[] = [];
    for (let i = 0; i < MAX_RECENT + 4; i++) list = remember('ana', list, item(`a${i}`), 1000 + i);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].a).toBe(`a${MAX_RECENT + 3}`);

    list = setPinned('ana', list, item(`a${MAX_RECENT + 3}`), true);
    for (let i = 0; i < MAX_RECENT + 4; i++) list = remember('ana', list, item(`z${i}`), 5000 + i);
    expect(list.filter((entry) => entry.pinned)).toHaveLength(1);
    expect(list.filter((entry) => !entry.pinned)).toHaveLength(MAX_RECENT);
    expect(list[0].a).toBe(`a${MAX_RECENT + 3}`); // saved comes first, whatever the dates
  });

  it('cuts the saved comparisons at their limit, dropping the oldest', () => {
    const many = Array.from({ length: MAX_PINNED + 3 }, (_, i): SavedComparison => ({ a: `a${i}`, b: null, info: info(i), at: i, pinned: true }));
    const kept = order(many);
    expect(kept).toHaveLength(MAX_PINNED);
    expect(kept[0].a).toBe(`a${MAX_PINNED + 2}`);
  });
});

describe('setPinned and forget', () => {
  it('saves a comparison and lets it go back to the recent ones', () => {
    let list = remember('ana', [], item('a1', 'b1'), 1);
    list = setPinned('ana', list, { a: 'a1', b: 'b1' }, true);
    expect(loadSaved('ana')[0].pinned).toBe(true);
    list = setPinned('ana', list, { a: 'a1', b: 'b1' }, false);
    expect(loadSaved('ana')[0].pinned).toBe(false);
  });

  it('forgets one comparison and leaves the others', () => {
    let list = remember('ana', remember('ana', [], item('a1'), 1), item('a2'), 2);
    list = forget('ana', list, { a: 'a1', b: null });
    expect(list.map((entry) => entry.a)).toEqual(['a2']);
    expect(loadSaved('ana').map((entry) => entry.a)).toEqual(['a2']);
  });

  it('knows which comparison is the one on screen', () => {
    expect(isCurrent({ a: 'a1', b: null }, 'a1', null)).toBe(true);
    expect(isCurrent({ a: 'a1', b: 'b1' }, 'a1', null)).toBe(false);
    expect(isCurrent({ a: 'a1', b: null }, null, null)).toBe(false);
  });
});

describe('storage that does not work', () => {
  it('reads nothing when the browser throws, and when what is kept is damaged or is not a list of comparisons', () => {
    localStorage.setItem(savedStorageKey('ana'), '{not json');
    expect(loadSaved('ana')).toEqual([]);
    localStorage.setItem(savedStorageKey('ana'), JSON.stringify({ a: 1 }));
    expect(loadSaved('ana')).toEqual([]);
    localStorage.setItem(savedStorageKey('ana'), JSON.stringify([{ a: 'a1' }, { a: '', b: null, info: info(1), at: 1, pinned: false }, 7, null, { a: 'ok', b: null, info: info(1), at: 1, pinned: false }]));
    expect(loadSaved('ana').map((entry) => entry.a)).toEqual(['ok']);

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadSaved('ana')).toEqual([]);
  });

  it('still gives the list back, for this visit, when it cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    let list = remember('ana', [], item('a1'), 1);
    list = remember('ana', list, item('a2'), 2);
    expect(list.map((entry) => entry.a)).toEqual(['a2', 'a1']);
    list = setPinned('ana', list, item('a1'), true);
    expect(list[0]).toMatchObject({ a: 'a1', pinned: true });
    expect(forget('ana', list, item('a1')).map((entry) => entry.a)).toEqual(['a2']);
  });
});
