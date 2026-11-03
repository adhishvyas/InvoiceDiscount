import type { Address, Hash } from 'viem';

/**
 * A Mesh session's state, as mesh-server reports it (Mesh spec §4.3).
 * - `awaiting-transfer`: created, no webhook yet.
 * - `pending`: a `Pending` webhook arrived (not guaranteed in sandbox; nothing depends on it).
 * - `succeeded`: a `Succeeded` webhook arrived and is being processed.
 * - `settled`: mesh-server's `settleDirect()` succeeded (`settleTx` set).
 * - `failed`: a `Failed` webhook arrived; the buyer can start again.
 * - `needs-attention`: funds may have arrived but nothing was settled; `reason` says why.
 */
export type SessionState = 'awaiting-transfer' | 'pending' | 'succeeded' | 'settled' | 'failed' | 'needs-attention';

/** Who paid, from the `Succeeded` webhook (`SourceAccountProvider`, `SourceAddress`, `RefundAddress`). */
export interface Payer {
  provider?: string;
  sourceAddress?: string;
  refundAddress?: string;
}

/**
 * A session as `GET /invoices/:address/mesh-session/:id` and `GET /invoices/:address/mesh-sessions` return it
 * (Mesh spec §4.3). Absent optional fields are omitted.
 */
export interface SessionView {
  id: string;
  invoice: Address;
  state: SessionState;
  /** Base units, decimal string. */
  amount: string;
  discountBps: number;
  /** Unix seconds. */
  expiresAt: number;
  transferTx?: Hash;
  settleTx?: Hash;
  reason?: string;
  payer?: Payer;
}

/** The `201` body of `POST /invoices/:address/mesh-session` (Mesh spec §4.3). */
export interface MeshSessionStart {
  id: string;
  /** For Mesh Link's `openLink`. */
  linkToken: string;
  /** Base units, decimal string. */
  amount: string;
  /** `amount` formatted with the token's decimals. */
  displayAmount: string;
  symbol: string;
  discountBps: number;
  /** Unix seconds; the quote is valid until then. */
  expiresAt: number;
}

/** Whether to stop polling a session: true for `settled`, `failed` and `needs-attention`, false for the other three. */
export function isFinalMeshState(state: SessionState): boolean {
  throw new Error('unimplemented');
}
