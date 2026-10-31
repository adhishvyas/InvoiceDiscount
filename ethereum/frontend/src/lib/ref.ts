import { hexToString, stringToHex, type Hex } from 'viem';

/** The on-chain limit for an invoice reference, in UTF-8 bytes (it is stored as a bytes32). */
export const REF_MAX_BYTES = 32;

const encoder = new TextEncoder();

/** The reference exactly as typed, minus leading and trailing whitespace. */
const normalize = (s: string): string => s.trim();

/**
 * UTF-8 byte length of the reference after trimming leading and trailing whitespace
 * (the on-chain limit is bytes, not characters). Inner whitespace counts. `'   '` is 0; `'ü'` is 2.
 */
export const refByteLength = (s: string): number => encoder.encode(normalize(s)).length;

/**
 * Trimmed reference as a left-aligned, zero-padded bytes32 (viem `stringToHex(ref, { size: 32 })`).
 * Throws if the trimmed reference is over {@link REF_MAX_BYTES} bytes; exactly 32 is accepted.
 * An empty or all-whitespace string encodes to bytes32(0); `validateInvoiceForm` blocks it, not this.
 * @example encodeRef('  A  ') === '0x41' + '00'.repeat(31)
 */
export const encodeRef = (s: string): Hex => {
  if (refByteLength(s) > REF_MAX_BYTES) throw new Error(`Reference is longer than ${REF_MAX_BYTES} bytes`);
  return stringToHex(normalize(s), { size: REF_MAX_BYTES });
};

/** bytes32 back to the reference string, without the zero padding. `decodeRef(encodeRef(s)) === s.trim()`. */
export const decodeRef = (b: Hex): string =>
  // viem leaves one zero byte when the value is all zeros; drop any trailing padding.
  hexToString(b, { size: REF_MAX_BYTES }).replace(/\0+$/, '');
