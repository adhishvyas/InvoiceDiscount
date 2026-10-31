/**
 * The next tier cutoff, if it is less than `windowSeconds` away (spec §5.3: warn that the split may change
 * when the transaction is included after it).
 * Returns the smallest `cutoff` with `now < cutoff` and `cutoff - now < windowSeconds`, else `undefined`.
 * A cutoff equal to `now` has already passed (the contract applies a tier while `timestamp < cutoff`);
 * one exactly `windowSeconds` away is outside the window. No tiers, or only past ones, give `undefined`.
 * `tiers` need not be sorted. All values are unix seconds.
 * @example upcomingCutoff([{ cutoff: 1_000n }], 800n) === 1_000n; upcomingCutoff([{ cutoff: 1_000n }], 700n) === undefined
 */
export function upcomingCutoff(
  tiers: readonly { cutoff: bigint }[],
  now: bigint,
  windowSeconds = 300n,
): bigint | undefined {
  throw new Error('unimplemented');
}
