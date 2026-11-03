// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v2): exported names, signatures and documented behaviour.
import type { Address, Hash } from 'viem';

/**
 * - `awaiting-transfer`: created, no webhook yet.
 * - `pending`: a `pending` or `compliance_hold` status arrived (nothing depends on it).
 * - `succeeded`: a `completed` status arrived and is being processed.
 * - `settled`: `settleDirect()` from this server succeeded (`settleTx` set).
 * - `failed`: a `failed` or `refunded` status arrived (`reason` says which); the buyer can start again.
 * - `needs-attention`: funds may have arrived but nothing was settled; `reason` says why.
 */
export type SessionState = 'awaiting-transfer' | 'pending' | 'succeeded' | 'settled' | 'failed' | 'needs-attention';

/**
 * Who paid, from the `completed` webhook: `provider` is `source.crypto.venue` (e.g. `metamask`, `coinbase`), else
 * `source.kind`; `sourceAddress` is `source.crypto.address` (absent for an exchange). v2 has no refund address.
 */
export interface Payer {
  provider?: string;
  sourceAddress?: string;
}

export interface Session {
  id: string;
  /** Checksummed. */
  invoice: Address;
  transactionId: string;
  /** Quoted amount in base units; 0n for a session recreated from a webhook after a restart (no quote). */
  amount: bigint;
  discountBps: number;
  symbol: string;
  /** Unix seconds; 0n when recreated from a webhook. */
  expiresAt: bigint;
  state: SessionState;
  /** The destination leg's `tx_hash` from the webhook (the inbound transfer). */
  transferTx?: Hash;
  settleTx?: Hash;
  reason?: string;
  payer?: Payer;
}

/** The JSON shape of a session in every endpoint response (Mesh spec §4.3). Absent optional fields are omitted. */
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

/** In-memory sessions, one process (Mesh spec §2: a restart loses them). */
export class SessionStore {
  /**
   * Adds a session in state `awaiting-transfer` and returns it. `invoice` is stored checksummed.
   * Throws if `id` or `transactionId` is already present.
   */
  create(init: Omit<Session, 'state'>): Session {
    throw new Error('unimplemented');
  }

  get(id: string): Session | undefined {
    throw new Error('unimplemented');
  }

  byTransactionId(transactionId: string): Session | undefined {
    throw new Error('unimplemented');
  }

  /** The invoice's sessions (address in any case), most recently created first; `[]` if none. */
  forInvoice(invoice: Address): Session[] {
    throw new Error('unimplemented');
  }

  /** Merges `patch` into the session and returns it. `id`, `invoice` and `transactionId` can't change. Throws for an unknown id. */
  update(id: string, patch: Partial<Omit<Session, 'id' | 'invoice' | 'transactionId'>>): Session {
    throw new Error('unimplemented');
  }
}

/** `Session` → `SessionView`: `amount` as a decimal string, `expiresAt` as a number, `transactionId` dropped. */
export function sessionView(s: Session): SessionView {
  throw new Error('unimplemented');
}
