import { formatUnits, parseUnits } from 'viem';

/** Decimal amount string to token base units. `decimals` comes from the token's `decimals()`. */
export const toUnits = (amount: string, decimals: number): bigint => parseUnits(amount, decimals);

/** Token base units to a decimal amount string. */
export const fromUnits = (units: bigint, decimals: number): string => formatUnits(units, decimals);
