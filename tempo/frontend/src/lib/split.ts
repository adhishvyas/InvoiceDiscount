export const BPS_DENOMINATOR = 10_000n;

/** The contract's split: the refund is floored and the seller gets the remainder. */
export const computeSplit = (principal: bigint, discountBps: number): { toSeller: bigint; refund: bigint } => {
  const refund = (principal * BigInt(discountBps)) / BPS_DENOMINATOR;
  return { toSeller: principal - refund, refund };
};
