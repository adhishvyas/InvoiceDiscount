import { describe, expect, it } from 'vitest';
import { blockRanges } from './logs';

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
  it('never exceeds the RPC limit by default', () => {
    for (const [from, to] of blockRanges(0n, 1_000_000n)) expect(to - from).toBeLessThan(100_000n);
  });
});
