import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits } from 'viem';
import { quoteAmount, quoteBps, toMeshAmount } from './quote';

/** Mirrors `_activeDiscount`: the first tier whose cutoff is still ahead applies. */
const tiersAt = (tiers: { cutoff: bigint; bps: number }[]) => async (ts: bigint) =>
  tiers.find((tier) => ts < tier.cutoff)?.bps ?? 0;

const T = 1_800_000_000n;
const cutoffsOf = (tiers: { cutoff: bigint }[]) => tiers.map((x) => x.cutoff);

describe('quoteBps', () => {
  it('is 0 with no tiers', async () => {
    expect(await quoteBps(T, [], tiersAt([]))).toBe(0);
  });

  it('is the current tier when no cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 1000n, bps: 1500 }, { cutoff: T + 2000n, bps: 1000 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(1500);
  });

  it('takes the next, smaller tier when its cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1500 }, { cutoff: T + 2000n, bps: 1000 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(1000);
  });

  it('keeps the current tier when the next one in the window is larger', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1000 }, { cutoff: T + 2000n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(1000);
  });

  it('is 0 when the last cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(0);
  });

  it('is 0 past the last cutoff', async () => {
    const tiers = [{ cutoff: T - 1n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(0);
  });

  it('counts a cutoff exactly at t + 900', async () => {
    const tiers = [{ cutoff: T + 900n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(0);
  });

  it('ignores a cutoff at t + 901', async () => {
    const tiers = [{ cutoff: T + 901n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(1500);
  });

  it('the old 180 s window is not used: a cutoff at t + 500 counts', async () => {
    const tiers = [{ cutoff: T + 500n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers))).toBe(0);
  });

  it('does not ask about a cutoff at t, which has already passed', async () => {
    const asked: bigint[] = [];
    const discountAt = async (ts: bigint) => {
      asked.push(ts);
      return 0;
    };
    await quoteBps(T, [T], discountAt);
    expect(asked).toEqual([T]);
  });

  it('asks exactly about t and the cutoffs with t < c <= t + window, regardless of order', async () => {
    const asked: bigint[] = [];
    const discountAt = async (ts: bigint) => {
      asked.push(ts);
      return 100;
    };
    await quoteBps(T, [T + 901n, T + 900n, T - 5n, T, T + 1n, T + 450n], discountAt);
    expect([...asked].sort()).toEqual([T, T + 1n, T + 450n, T + 900n].sort());
    expect(asked).toHaveLength(4);
  });

  it('honours an explicit window', async () => {
    const tiers = [{ cutoff: T + 50n, bps: 1500 }];
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers), 49n)).toBe(1500);
    expect(await quoteBps(T, cutoffsOf(tiers), tiersAt(tiers), 50n)).toBe(0);
  });
});

describe('quoteAmount', () => {
  it('floors the discount, so the seller gets the remainder', () => {
    expect(quoteAmount(100_000_000n, 1500)).toBe(85_000_000n);
    expect(quoteAmount(333n, 1500)).toBe(284n); // discount 49.95 -> 49
  });

  it('is the principal at 0 bps and 0 at 10_000 bps', () => {
    expect(quoteAmount(123n, 0)).toBe(123n);
    expect(quoteAmount(123n, 10_000)).toBe(0n);
  });

  it('floors small discounts to nothing and rounds odd amounts the same way as the contract', () => {
    expect(quoteAmount(9_999n, 1)).toBe(9_999n);
    expect(quoteAmount(10_000n, 1)).toBe(9_999n);
    expect(quoteAmount(3n, 5_000)).toBe(2n); // discount 1.5 -> 1
    expect(quoteAmount(1n, 5_000)).toBe(1n);
    expect(quoteAmount(1_000_001n, 1_234)).toBe(876_601n);
  });

  it('does not lose precision on a uint128 principal', () => {
    const max = 2n ** 128n - 1n;
    expect(quoteAmount(max, 1)).toBe(max - (max * 1n) / 10_000n);
    expect(quoteAmount(max, 10_000)).toBe(0n);
  });
});

describe('toMeshAmount', () => {
  it('converts base units to a token-unit number at 6 decimals', () => {
    expect(toMeshAmount(1n, 6)).toBe(0.000001);
    expect(toMeshAmount(999_999n, 6)).toBe(0.999999);
    expect(toMeshAmount(1_000_000n, 6)).toBe(1);
    expect(toMeshAmount(90_000_000n, 6)).toBe(90);
    expect(toMeshAmount(123_456_789n, 6)).toBe(123.456789);
    expect(toMeshAmount(0n, 6)).toBe(0);
  });

  it('round-trips odd quoteAmount results back to the same base units', () => {
    const amounts = [
      quoteAmount(333n, 1500),
      quoteAmount(1_000_001n, 1_234),
      quoteAmount(7n, 3_333),
      quoteAmount(999_999n, 1),
      quoteAmount(123_456_789n, 4_321),
      quoteAmount(5_000_000_001n, 777),
    ];
    for (const amount of amounts) {
      const n = toMeshAmount(amount, 6);
      expect(typeof n).toBe('number');
      expect(n).toBe(Number(formatUnits(amount, 6)));
      expect(parseUnits(String(n), 6)).toBe(amount);
    }
  });

  it('works at 18 decimals when the double holds the value', () => {
    expect(toMeshAmount(1_500_000_000_000_000_000n, 18)).toBe(1.5);
  });

  it('throws where a JSON number cannot hold the value', () => {
    expect(toMeshAmount(1_000_000n, 6)).toBe(1); // the same call succeeds where the value fits
    expect(() => toMeshAmount(123_456_789_012_345_678n, 18)).toThrow(Error);
    expect(() => toMeshAmount(10n ** 18n + 1n, 18)).toThrow(Error);
    expect(() => toMeshAmount(9_007_199_254_740_993_000_000n, 6)).toThrow(Error);
    expect(() => toMeshAmount(2n ** 53n + 1n, 0)).toThrow(Error);
  });
});
