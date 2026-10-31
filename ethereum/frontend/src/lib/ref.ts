import type { Hex } from 'viem';

/** The on-chain limit for an invoice reference, in UTF-8 bytes (it is stored as a bytes32). */
export const REF_MAX_BYTES = 32;

/**
 * UTF-8 byte length of the reference after trimming leading and trailing whitespace
 * (the on-chain limit is bytes, not characters). Inner whitespace counts. `'   '` is 0; `'ü'` is 2.
 */
export const refByteLength = (s: string): number => {
  throw new Error('unimplemented');
};

/**
 * Trimmed reference as a left-aligned, zero-padded bytes32 (viem `stringToHex(ref, { size: 32 })`).
 * Throws if the trimmed reference is over {@link REF_MAX_BYTES} bytes; exactly 32 is accepted.
 * An empty or all-whitespace string encodes to bytes32(0); `validateInvoiceForm` blocks it, not this.
 * @example encodeRef('  A  ') === '0x41' + '00'.repeat(31)
 */
export const encodeRef = (s: string): Hex => {
  throw new Error('unimplemented');
};

/** bytes32 back to the reference string, without the zero padding. `decodeRef(encodeRef(s)) === s.trim()`. */
export const decodeRef = (b: Hex): string => {
  throw new Error('unimplemented');
};
