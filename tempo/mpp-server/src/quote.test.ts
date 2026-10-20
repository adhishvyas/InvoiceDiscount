import { describe, expect, it } from 'vitest';
import { quoteAmount, quoteBps } from './quote';

/** Mirrors `_activeDiscount`: the first tier whose cutoff is still ahead applies. */
const tiersAt = (tiers: { cutoff: bigint; bps: number }[]) => async (ts: bigint) =>
  tiers.find((tier) => ts < tier.cutoff)?.bps ?? 0;

const T = 1_800_000_000n;

describe('quoteBps', () => {
  it('is 0 with no tiers', async () => {
    expect(await quoteBps(T, [], tiersAt([]))).toBe(0);
  });

  it('is the current tier when no cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 1000n, bps: 1500 }, { cutoff: T + 2000n, bps: 1000 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(1500);
  });

  it('takes the next, smaller tier when its cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1500 }, { cutoff: T + 2000n, bps: 1000 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(1000);
  });

  it('keeps the current tier when the next one in the window is larger', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1000 }, { cutoff: T + 2000n, bps: 1500 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(1000);
  });

  it('is 0 when the last cutoff falls in the window', async () => {
    const tiers = [{ cutoff: T + 100n, bps: 1500 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(0);
  });

  it('is 0 past the last cutoff', async () => {
    const tiers = [{ cutoff: T - 1n, bps: 1500 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(0);
  });

  it('counts a cutoff exactly at t + 180', async () => {
    const tiers = [{ cutoff: T + 180n, bps: 1500 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(0);
  });

  it('ignores a cutoff just after the window', async () => {
    const tiers = [{ cutoff: T + 181n, bps: 1500 }];
    expect(await quoteBps(T, tiers.map((x) => x.cutoff), tiersAt(tiers))).toBe(1500);
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
});

describe('quoteAmount', () => {
  it('floors the discount, so the seller gets the remainder', () => {
    expect(quoteAmount(100_000_000n, 1500)).toBe(85_000_000n);
    expect(quoteAmount(333n, 1500)).toBe(284n); // discount 49.95 → 49
  });

  it('is the principal at 0 bps and 0 at 10_000 bps', () => {
    expect(quoteAmount(123n, 0)).toBe(123n);
    expect(quoteAmount(123n, 10_000)).toBe(0n);
  });
});
