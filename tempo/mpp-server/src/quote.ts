/** Challenge expiry (120 s) plus 60 s for the transfer and `settleDirect()` (MPP spec §4.2). */
export const QUOTE_WINDOW = 180n;

/**
 * The smallest discount that applies at any instant in `[t, t + window]`.
 * A tier applies strictly before its cutoff, so the candidates are `t` and every cutoff in `(t, t + window]`.
 * `discountAt` calls the contract's `activeDiscount`, so tier logic isn't reimplemented here.
 */
export async function quoteBps(
  t: bigint,
  cutoffs: readonly bigint[],
  discountAt: (timestamp: bigint) => Promise<number>,
  window = QUOTE_WINDOW,
): Promise<number> {
  const candidates = [t, ...cutoffs.filter((c) => c > t && c <= t + window)];
  const discounts = await Promise.all(candidates.map(discountAt));
  return Math.min(...discounts);
}

/** `principal - floor(principal * bps / 10_000)`, the same rounding as `settleDirect()`. */
export function quoteAmount(principal: bigint, bps: number): bigint {
  return principal - (principal * BigInt(bps)) / 10_000n;
}
