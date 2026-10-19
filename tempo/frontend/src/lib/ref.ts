import { hexToString, stringToHex, type Hex } from 'viem';

export const REF_MAX_BYTES = 32;

const encoder = new TextEncoder();

/** The reference exactly as typed, minus leading and trailing whitespace. */
const normalize = (s: string): string => s.trim();

/** UTF-8 byte length of the trimmed reference (the on-chain limit is bytes, not characters). */
export const refByteLength = (s: string): number => encoder.encode(normalize(s)).length;

/** Trimmed reference as a left-aligned, zero-padded bytes32. Throws if it is over 32 bytes. */
export const encodeRef = (s: string): Hex => {
  if (refByteLength(s) > REF_MAX_BYTES) throw new Error(`Reference is longer than ${REF_MAX_BYTES} bytes`);
  return stringToHex(normalize(s), { size: REF_MAX_BYTES });
};

/** bytes32 back to the reference string, without the zero padding. */
export const decodeRef = (b: Hex): string => hexToString(b, { size: REF_MAX_BYTES });
