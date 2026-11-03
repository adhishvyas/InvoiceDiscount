// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import type { Address, Client, Hash } from 'viem';
import type { SessionStore } from './sessions';

/** The fields of a Mesh transfer webhook this server reads (explainer §6). Other fields are ignored. */
export interface MeshWebhookEvent {
  /** Stable across retries: the idempotency key. */
  EventId: string;
  /** Ours, from `encodeTransactionId`. */
  TransactionId: string;
  /** `Pending` | `Succeeded` | `Failed`; anything else is ignored. */
  TransferStatus: string;
  TxHash?: string | null;
  Chain?: string;
  Token?: string;
  DestinationAddress?: string;
  SourceAccountProvider?: string;
  SourceAddress?: string;
  RefundAddress?: string;
  [field: string]: unknown;
}

export interface WebhookContext {
  client: Client;
  factory: Address;
  sessions: SessionStore;
  /** Mesh-supported token address (checksummed) → Mesh's symbol, which the webhook's `Token` must equal. */
  meshTokens: Record<Address, string>;
  /** The `Chain` string a Sepolia webhook carries. */
  chainName: string;
  /** Sends `settleDirect()` on `invoice` and resolves to its tx hash once sent (not mined); rejects on a revert in simulation. */
  settle: (invoice: Address) => Promise<Hash>;
  /** How long to wait for the inbound `TxHash` receipt (180_000 in production). Waits poll at the client's `pollingInterval`. */
  receiptTimeoutMs: number;
}

/**
 * Builds the processor for webhook events (Mesh spec §4.3 webhook steps 3–6). The returned function resolves once
 * the event is fully handled, and never rejects: unexpected errors are logged and, when the session is known, recorded
 * as `needs-attention` with the error's message.
 *
 * In order:
 * 1. **Dedup:** an `EventId` already seen by this processor (including one still being processed) → no-op.
 * 2. **Session:** look up `TransactionId` in `sessions`. If absent, `decodeTransactionId` it: undecodable, or the
 *    invoice isn't a clone of `factory`'s implementation (`isClone`) → ignored, no session created. Otherwise create a
 *    session for it (id from the `transactionId`, `amount` 0n, `discountBps` 0, `expiresAt` 0n, `symbol` = `Token` or '').
 * 3. **Serialize:** events for the same invoice are handled one at a time, in arrival order; different invoices run
 *    concurrently.
 * 4. By `TransferStatus`:
 *    - `Pending`: `awaiting-transfer` → `pending`; any other state is left as is.
 *    - `Failed`: `awaiting-transfer` or `pending` → `failed`; any other state is left as is.
 *    - `Succeeded`: ignored if the session is already `settled`. Otherwise state `succeeded`, `transferTx` = `TxHash`
 *      (if present), `payer` = `{ provider: SourceAccountProvider, sourceAddress: SourceAddress, refundAddress: RefundAddress }`. Then:
 *      a. `DestinationAddress` must equal the invoice (case-insensitively) and `Chain` must equal `chainName`; else
 *         `needs-attention`, reason `destination mismatch` / `chain mismatch`, no settle.
 *      b. If `TxHash` is present, wait up to `receiptTimeoutMs` for its receipt. Not found, or reverted, is **not** a
 *         failure: processing continues, because the balance decides.
 *      c. `readInvoice`. `Token` must equal `meshTokens[invoice.token]`; else `needs-attention`, reason `token mismatch`.
 *      d. Status Paid → `needs-attention`, reason `already Paid`; Funded or Cancelled → `needs-attention`, reason
 *         `invoice is Funded` / `invoice is Cancelled`. No settle.
 *      e. `balance = tokenBalance(invoice.token, invoice)`, `due = dueNow(...)`. Unless `balance > 0n && balance >= due`:
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
