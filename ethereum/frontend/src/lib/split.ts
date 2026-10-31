/** Basis points in 100%; the contract's `discountBps` is at most this. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * The contract's split of `principal` at `discountBps` (0..10_000): `refund = floor(principal * bps / 10_000)`
 * and the seller gets the remainder, so `toSeller + refund === principal`.
 * @example computeSplit(1001n, 1500) → { toSeller: 851n, refund: 150n }; computeSplit(500n, 10_000) → { toSeller: 0n, refund: 500n }
 */
export const computeSplit = (principal: bigint, discountBps: number): { toSeller: bigint; refund: bigint } => {
  const refund = (principal * BigInt(discountBps)) / BPS_DENOMINATOR;
  return { toSeller: principal - refund, refund };
};
