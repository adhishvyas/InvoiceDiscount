// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import type { Address } from 'viem';

/** A new session id: 16 random lowercase hex characters (from `node:crypto`). */
export function newSessionId(): string {
  throw new Error('unimplemented');
}

/**
 * The `transactionId` given to Mesh: `<invoice, lowercase, with 0x>-<id>`, 59 characters for a 16-character id.
 * `invoice` may be in any case; the output is always lowercase.
 */
export function encodeTransactionId(invoice: Address, id: string): string {
  throw new Error('unimplemented');
}

/**
 * The inverse of `encodeTransactionId`. Accepts exactly `0x` + 40 hex + `-` + 16 hex (hex in any case) and returns the
 * invoice as a checksummed address and the id in lowercase. Anything else (wrong lengths, missing parts, extra
 * characters, non-hex) → `undefined`.
 */
export function decodeTransactionId(transactionId: string): { invoice: Address; id: string } | undefined {
  throw new Error('unimplemented');
}
