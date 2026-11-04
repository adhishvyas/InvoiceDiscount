import type { Address } from 'viem';

/** The `token` of a native-ETH invoice (native-ETH spec §2): the zero address. */
export const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000';

/** ETH's decimals. Used for native invoices instead of calling `decimals()`, which the zero address doesn't have. */
export const NATIVE_DECIMALS = 18;

/** Whether `token` is `NATIVE_TOKEN`, compared case-insensitively. Any other string, including a non-address, is false. */
export function isNative(token: string): boolean {
  return token.toLowerCase() === NATIVE_TOKEN;
}
