import { describe, expect, it } from 'vitest';
import { LOG_PAGE_SIZE, blockRanges } from './logs';

describe('blockRanges', () => {
  it('covers a short range in one page', () => {
    expect(blockRanges(10n, 20n, 50n)).toEqual([[10n, 20n]]);
    expect(blockRanges(10n, 10n, 50n)).toEqual([[10n, 10n]]);
  });
  it('splits at the page size with no gaps or overlaps', () => {
    expect(blockRanges(0n, 249n, 100n)).toEqual([[0n, 99n], [100n, 199n], [200n, 249n]]);
    expect(blockRanges(0n, 199n, 100n)).toEqual([[0n, 99n], [100n, 199n]]);
    expect(blockRanges(0n, 200n, 100n)).toEqual([[0n, 99n], [100n, 199n], [200n, 200n]]);
  });
  it('returns nothing when from is after to', () => {
    expect(blockRanges(11n, 10n, 50n)).toEqual([]);
  });
  it('handles a page size of 1', () => {
    expect(blockRanges(3n, 5n, 1n)).toEqual([[3n, 3n], [4n, 4n], [5n, 5n]]);
  });
  it('starts at a non-zero block and ends exactly at toBlock', () => {
    const ranges = blockRanges(7n, 30n, 10n);
    expect(ranges[0][0]).toBe(7n);
    expect(ranges.at(-1)![1]).toBe(30n);
    expect(ranges).toEqual([[7n, 16n], [17n, 26n], [27n, 30n]]);
  });
  it('never exceeds the RPC limit by default', () => {
    for (const [from, to] of blockRanges(0n, 1_000_000n)) expect(to - from).toBeLessThan(LOG_PAGE_SIZE);
  });
  it('defaults to LOG_PAGE_SIZE-block pages', () => {
    expect(blockRanges(0n, LOG_PAGE_SIZE * 2n - 1n)).toEqual([
      [0n, LOG_PAGE_SIZE - 1n],
      [LOG_PAGE_SIZE, LOG_PAGE_SIZE * 2n - 1n],
    ]);
  });
});
