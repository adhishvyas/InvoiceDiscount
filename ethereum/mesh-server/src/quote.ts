// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import { formatUnits, parseUnits } from 'viem';

/** Link Token life (600 s) plus 300 s for the transfer to land and `settleDirect()` to be included (Mesh spec §4.2). */
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

/**
 * Base units → the JSON number Mesh takes as `amount`, in token units (`Number(formatUnits(amount, decimals))`).
 * Throws an `Error` if that number doesn't convert back to exactly `amount` base units
 * (`parseUnits(String(n), decimals) !== amount`), e.g. an 18-decimal amount with more digits than a double holds.
 */
export function toMeshAmount(amount: bigint, decimals: number): number {
  const n = Number(formatUnits(amount, decimals));
  if (parseUnits(String(n), decimals) !== amount) throw new Error(`${amount} base units at ${decimals} decimals isn't exact as a JSON number`);
  return n;
}
