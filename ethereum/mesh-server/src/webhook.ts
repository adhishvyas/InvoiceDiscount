// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import type { Address, Client, Hash } from 'viem';
import type { SessionStore } from './sessions';

/** A crypto leg of a v2 transfer webhook (explainer §6). Every field is optional on the wire. */
export interface MeshCryptoLeg {
  address?: string;
  /** Wallet or exchange id, e.g. `metamask`, `coinbase`. */
  venue?: string;
  network_caip2?: string;
  asset?: { symbol?: string; decimals?: number };
  amount?: { value?: string };
  tx_hash?: string;
}

export interface MeshTransferSide {
  /** e.g. `wallet`, `exchange`, `manual`. */
  kind?: string;
  crypto?: MeshCryptoLeg;
}

/** `data.transfer` of a `transfer.*` webhook, snake_case. Fields this server doesn't read are omitted. */
export interface MeshTransfer {
  transfer_id?: string;
  /** `pending` | `completed` | `failed` | `compliance_hold` | `refunded`. */
  status?: string;
  source?: MeshTransferSide;
  destination?: MeshTransferSide;
  /** Ours, from `encodeTransactionId`. */
  client_transaction_id?: string;
  error_code?: string;
  error_message?: string;
}

/** A v2 webhook delivery body (explainer §6). Other envelope fields are ignored. */
export interface MeshWebhookEvent {
  version?: string;
  /** Stable across retries: the idempotency key. */
  event_id?: string;
  /** e.g. `transfer.completed`, `transfer.status_updated`. */
  type?: string;
  data?: { transfer?: MeshTransfer; previous_status?: string };
  [field: string]: unknown;
}

export interface WebhookContext {
  client: Client;
  factory: Address;
  sessions: SessionStore;
  /** Mesh-supported token address (checksummed) → Mesh's symbol. */
  meshTokens: Record<Address, string>;
  /** The target network's CAIP-2 id, e.g. `eip155:11155111`. */
  networkCaip2: string;
  /** Sends `settleDirect()` on `invoice` and resolves to its tx hash once sent (not mined); rejects on a revert in simulation. */
  settle: (invoice: Address) => Promise<Hash>;
  /** How long to wait for the inbound `tx_hash` receipt (180_000 in production). Waits poll at the client's `pollingInterval`. */
  receiptTimeoutMs: number;
}

/**
 * Builds the processor for webhook events (Mesh spec §4.3 webhook steps 3–5). The returned function resolves once
 * the event is fully handled and never rejects: unexpected errors are logged and, when the session is known, recorded
 * as `needs-attention` with the error's message.
 *
 * In order (`t` below is `event.data.transfer`):
 * 1. **Filter:** ignored unless `version === "1"`, `type` starts with `transfer.`, `t` is an object, and `event_id`
 *    is a non-empty string.
 * 2. **Dedup:** an `event_id` already seen by this processor (including one still being processed, and including
 *    events later ignored in step 3) → no-op. Events dropped by step 1 aren't recorded as seen.
 * 3. **Session:** look up `t.client_transaction_id` in `sessions`. If absent, `decodeTransactionId` it: missing,
 *    undecodable, or the invoice isn't a clone of `factory`'s implementation (`isClone`) → ignored, no session
 *    created. Otherwise create a session for it (id from the id, `amount` 0n, `discountBps` 0, `expiresAt` 0n,
 *    `symbol` = `t.destination.crypto.asset.symbol` or '').
 * 4. **Serialize:** events for the same invoice are handled one at a time, in arrival order; different invoices run
 *    concurrently.
 * 5. By `t.status` (not by `type`):
 *    - `pending` or `compliance_hold`: `awaiting-transfer` → `pending`; any other state is left as is.
 *    - `failed` or `refunded`: `awaiting-transfer` or `pending` → `failed`, reason = `t.error_code`, else
 *      `t.error_message`, else the status (`failed` / `refunded`); any other state is left as is.
 *    - `completed`: ignored if the session is already `settled`. Otherwise, with `dest = t.destination.crypto` and
 *      `src = t.source`: state `succeeded`, `reason` cleared, `transferTx` = `dest.tx_hash` (if present), `payer` =
 *      `{ provider: src.crypto.venue ?? src.kind, sourceAddress: src.crypto.address }`. Then:
 *      a. `dest.address` must equal the invoice (case-insensitively; absent counts as a mismatch), else
 *         `needs-attention`, reason `destination mismatch`. `dest.network_caip2`, **when present**, must equal
 *         `networkCaip2`, else reason `network mismatch`. No settle in either case.
 *      b. If `dest.tx_hash` is present, wait up to `receiptTimeoutMs` for its receipt. Not found, or reverted, is
 *         **not** a failure: processing continues, because the balance decides.
 *      c. `readInvoice`. `dest.asset.symbol`, **when present**, must equal `meshTokens[invoice.token]`; else
 *         `needs-attention`, reason `token mismatch`. (A token not in `meshTokens` with a symbol present is a mismatch.)
 *      d. Status Paid → `needs-attention`, reason `already Paid`; Funded or Cancelled → `needs-attention`, reason
 *         `invoice is Funded` / `invoice is Cancelled`. No settle.
 *      e. `balance = tokenBalance(invoice.token, invoice)` (the ETH balance for an ETH invoice), `due = dueNow(...)`. Unless `balance > 0n && balance >= due`:
 *         `needs-attention`, reason `insufficient balance: <balance> < <due>` (base units), no settle.
 *      f. `settle(invoice)`, then wait for that tx's receipt (no timeout). Success → `settled` with `settleTx`.
 *         Reverted receipt → `needs-attention` with `settleTx` and reason `settleDirect reverted`.
 *         `settle` rejects → `needs-attention`, reason = the custom error name when the error is a viem contract revert
 *         with decoded data (e.g. `InsufficientDirectPayment`), else viem's `shortMessage`, else the error's `message`.
 *    - Any other status: ignored.
 */
export function createEventProcessor(ctx: WebhookContext): (event: MeshWebhookEvent) => Promise<void> {
  throw new Error('unimplemented');
}
