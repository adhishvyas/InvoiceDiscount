// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';

const TRANSACTION_ID = /^(0x[0-9a-fA-F]{40})-([0-9a-fA-F]{16})$/;

/** A new session id: 16 random lowercase hex characters (from `node:crypto`). */
export function newSessionId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The `transactionId` given to Mesh: `<invoice, lowercase, with 0x>-<id>`, 59 characters for a 16-character id.
 * `invoice` may be in any case; the output is always lowercase.
 */
export function encodeTransactionId(invoice: Address, id: string): string {
  return `${invoice}-${id}`.toLowerCase();
}

/**
 * The inverse of `encodeTransactionId`. Accepts exactly `0x` + 40 hex + `-` + 16 hex (hex in any case) and returns the
 * invoice as a checksummed address and the id in lowercase. Anything else (wrong lengths, missing parts, extra
 * characters, non-hex) → `undefined`.
 */
export function decodeTransactionId(transactionId: string): { invoice: Address; id: string } | undefined {
  const match = TRANSACTION_ID.exec(transactionId);
  return match ? { invoice: getAddress(match[1].toLowerCase()), id: match[2].toLowerCase() } : undefined;
}
