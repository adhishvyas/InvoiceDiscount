// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v2): exported names, signatures and documented behaviour.
import { BaseError, ContractFunctionRevertedError, getAddress, type Address, type Client, type Hash } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { decodeTransactionId } from './ids';
import { dueNow, isClone, readInvoice, Status, STATUS_NAME, tokenBalance } from './invoice';
import type { Session, SessionStore } from './sessions';

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
 *      e. `balance = tokenBalance(invoice.token, invoice)`, `due = dueNow(...)`. Unless `balance > 0n && balance >= due`:
 *         `needs-attention`, reason `insufficient balance: <balance> < <due>` (base units), no settle.
 *      f. `settle(invoice)`, then wait for that tx's receipt (no timeout). Success → `settled` with `settleTx`.
 *         Reverted receipt → `needs-attention` with `settleTx` and reason `settleDirect reverted`.
 *         `settle` rejects → `needs-attention`, reason = the custom error name when the error is a viem contract revert
 *         with decoded data (e.g. `InsufficientDirectPayment`), else viem's `shortMessage`, else the error's `message`.
 *    - Any other status: ignored.
 */
export function createEventProcessor(ctx: WebhookContext): (event: MeshWebhookEvent) => Promise<void> {
  const seen = new Set<string>();
  const queues = new Map<Address, Promise<void>>();

  return async (event) => {
    try {
      const transfer = event?.data?.transfer;
      const id = event?.event_id;
      if (event?.version !== '1' || typeof event.type !== 'string' || !event.type.startsWith('transfer.')) return;
      if (typeof transfer !== 'object' || transfer === null || typeof id !== 'string' || id === '') return;
      if (seen.has(id)) return;
      seen.add(id);
      // Find the invoice synchronously, so events for one invoice queue in arrival order.
      const txId = transfer.client_transaction_id ?? '';
      const invoice = ctx.sessions.byTransactionId(txId)?.invoice ?? decodeTransactionId(txId)?.invoice;
      if (!invoice) return console.warn(`webhook ${id}: undecodable client_transaction_id, ignored`);
      const run = (queues.get(invoice) ?? Promise.resolve()).then(() => handle(ctx, invoice, id, transfer));
      queues.set(invoice, run);
      await run;
      if (queues.get(invoice) === run) queues.delete(invoice);
    } catch (error) {
      console.error(`webhook ${String(event?.event_id)}:`, error);
    }
  };
}

/** One event, with the invoice's queue held. Never rejects. */
async function handle(ctx: WebhookContext, invoice: Address, eventId: string, transfer: MeshTransfer): Promise<void> {
  let session: Session | undefined;
  try {
    session = await sessionFor(ctx, invoice, eventId, transfer);
    if (!session) return;
    await apply(ctx, session, transfer);
  } catch (error) {
    console.error(`webhook ${eventId}:`, error);
    if (session) ctx.sessions.update(session.id, { state: 'needs-attention', reason: errorReason(error) });
  }
}

/** The event's session, recreated from its `client_transaction_id` if this process lost it (a clone of `factory` only). */
async function sessionFor(ctx: WebhookContext, invoice: Address, eventId: string, transfer: MeshTransfer): Promise<Session | undefined> {
  const txId = transfer.client_transaction_id ?? '';
  const known = ctx.sessions.byTransactionId(txId);
  if (known) return known;
  const decoded = decodeTransactionId(txId);
  if (!decoded) return undefined;
  if (!(await isClone(ctx.client, ctx.factory, invoice))) {
    console.warn(`webhook ${eventId}: ${invoice} is not an invoice of this factory, ignored`);
    return undefined;
  }
  return ctx.sessions.create({
    id: decoded.id,
    invoice,
    transactionId: txId,
    amount: 0n,
    discountBps: 0,
    symbol: transfer.destination?.crypto?.asset?.symbol ?? '',
    expiresAt: 0n,
  });
}

async function apply(ctx: WebhookContext, session: Session, transfer: MeshTransfer): Promise<void> {
  const { sessions, client } = ctx;
  const id = session.id;
  const attention = (reason: string) => void sessions.update(id, { state: 'needs-attention', reason });

  switch (transfer.status) {
    case 'pending':
    case 'compliance_hold':
      if (session.state === 'awaiting-transfer') sessions.update(id, { state: 'pending' });
      return;
    case 'failed':
    case 'refunded':
      if (session.state === 'awaiting-transfer' || session.state === 'pending') {
        sessions.update(id, { state: 'failed', reason: transfer.error_code ?? transfer.error_message ?? transfer.status });
      }
      return;
    case 'completed':
      break;
    default:
      return;
  }
  if (session.state === 'settled') return;

  const dest = transfer.destination?.crypto;
  const src = transfer.source;
  const txHash = dest?.tx_hash ? (dest.tx_hash as Hash) : undefined;
  sessions.update(id, {
    state: 'succeeded',
    reason: undefined,
    transferTx: txHash ?? session.transferTx,
    payer: { provider: src?.crypto?.venue ?? src?.kind, sourceAddress: src?.crypto?.address },
  });

  if (dest?.address?.toLowerCase() !== session.invoice.toLowerCase()) return attention('destination mismatch');
  if (dest.network_caip2 !== undefined && dest.network_caip2 !== ctx.networkCaip2) return attention('network mismatch');

  // Wait for the reported transfer, but don't trust it either way: the balance below decides.
  if (txHash) await waitForTransactionReceipt(client, { hash: txHash, timeout: ctx.receiptTimeoutMs }).catch(() => undefined);

  const invoice = await readInvoice(client, session.invoice);
  const symbol = dest.asset?.symbol;
  if (symbol !== undefined && symbol !== ctx.meshTokens[getAddress(invoice.token)]) return attention('token mismatch');
  if (invoice.status === Status.Paid) return attention('already Paid');
  if (invoice.status !== Status.Active) return attention(`invoice is ${STATUS_NAME[invoice.status]}`);

  const [balance, due] = await Promise.all([tokenBalance(client, invoice.token, session.invoice), dueNow(client, session.invoice, invoice)]);
  if (!(balance > 0n && balance >= due)) return attention(`insufficient balance: ${balance} < ${due}`);

  let settleTx: Hash;
  try {
    settleTx = await ctx.settle(session.invoice);
  } catch (error) {
    return attention(errorReason(error));
  }
  sessions.update(id, { settleTx });
  const receipt = await waitForTransactionReceipt(client, { hash: settleTx });
  if (receipt.status === 'success') sessions.update(id, { state: 'settled' });
  else attention('settleDirect reverted');
}

/** The custom error name from a contract revert, else viem's short message, else the error's message. */
function errorReason(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
