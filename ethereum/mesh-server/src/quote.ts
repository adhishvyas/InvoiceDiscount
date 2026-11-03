// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v2): exported names, signatures and documented behaviour.

/** The quote's own life (600 s) plus 300 s for the transfer to land and `settleDirect()` to be included (Mesh spec §4.2). */
export const QUOTE_WINDOW = 900n;

/**
 * The smallest discount, in bps, that applies at any instant in `[t, t + window]` (Mesh spec §4.2).
 * A tier applies strictly before its cutoff, so the candidates are `t` and every cutoff `c` with `t < c <= t + window`;
 * a cutoff equal to `t` has already passed and isn't asked about. `discountAt` calls the contract's `activeDiscount`,
 * so tier logic isn't reimplemented here; it is called once per candidate.
 * With no tiers (or none in the window) the result is `discountAt(t)`.
 */
export async function quoteBps(
  t: bigint,
  cutoffs: readonly bigint[],
  discountAt: (timestamp: bigint) => Promise<number>,
  window: bigint = QUOTE_WINDOW,
): Promise<number> {
  const candidates = [t, ...cutoffs.filter((c) => c > t && c <= t + window)];
  const discounts = await Promise.all(candidates.map(discountAt));
  return Math.min(...discounts);
}

/** `principal - floor(principal * bps / 10_000)`, the same rounding as `settleDirect()`. 0 bps → principal; 10_000 bps → 0. */
export function quoteAmount(principal: bigint, bps: number): bigint {
  return principal - (principal * BigInt(bps)) / 10_000n;
}
