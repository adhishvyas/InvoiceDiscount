/**
 * Decimal amount string to token base units (viem `parseUnits`). `decimals` comes from the token's `decimals()`;
 * nothing assumes 6. Callers validate the string first (`validateInvoiceForm`).
 * @example toUnits('1.5', 6) === 1_500_000n; toUnits('1.5', 18) === 1_500_000_000_000_000_000n
 */
export const toUnits = (amount: string, decimals: number): bigint => {
  throw new Error('unimplemented');
};

/**
 * Token base units to a decimal amount string (viem `formatUnits`): no trailing zeros, no thousands separators.
 * @example fromUnits(1_500_000n, 6) === '1.5'; fromUnits(1n, 18) === '0.000000000000000001'
 */
export const fromUnits = (units: bigint, decimals: number): string => {
  throw new Error('unimplemented');
};
