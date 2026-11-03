// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import { BaseError, ContractFunctionRevertedError, getAddress, type Address, type Client, type Hash } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { decodeTransactionId } from './ids';
import { dueNow, isClone, readInvoice, Status, STATUS_NAME, tokenBalance } from './invoice';
import type { Session, SessionStore } from './sessions';

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
  const seen = new Set<string>();
  const queues = new Map<Address, Promise<void>>();

  return async (event) => {
    try {
      if (typeof event?.EventId !== 'string' || seen.has(event.EventId)) return;
      seen.add(event.EventId);
      // Find the invoice synchronously, so events for one invoice queue in arrival order.
      const invoice = ctx.sessions.byTransactionId(event.TransactionId)?.invoice ?? decodeTransactionId(event.TransactionId)?.invoice;
      if (!invoice) return console.warn(`webhook ${event.EventId}: undecodable TransactionId, ignored`);
      const run = (queues.get(invoice) ?? Promise.resolve()).then(() => handle(ctx, invoice, event));
      queues.set(invoice, run);
      await run;
      if (queues.get(invoice) === run) queues.delete(invoice);
    } catch (error) {
      console.error(`webhook ${String(event?.EventId)}:`, error);
    }
  };
}

/** One event, with the invoice's queue held. Never rejects. */
async function handle(ctx: WebhookContext, invoice: Address, event: MeshWebhookEvent): Promise<void> {
  let session: Session | undefined;
  try {
    session = await sessionFor(ctx, invoice, event);
    if (!session) return;
    await apply(ctx, session, event);
  } catch (error) {
    console.error(`webhook ${event.EventId}:`, error);
    if (session) ctx.sessions.update(session.id, { state: 'needs-attention', reason: errorReason(error) });
  }
}

/** The event's session, recreated from its `TransactionId` if this process lost it (a clone of `factory` only). */
async function sessionFor(ctx: WebhookContext, invoice: Address, event: MeshWebhookEvent): Promise<Session | undefined> {
  const known = ctx.sessions.byTransactionId(event.TransactionId);
  if (known) return known;
  const decoded = decodeTransactionId(event.TransactionId);
  if (!decoded) return undefined;
  if (!(await isClone(ctx.client, ctx.factory, invoice))) {
    console.warn(`webhook ${event.EventId}: ${invoice} is not an invoice of this factory, ignored`);
    return undefined;
  }
  return ctx.sessions.create({
    id: decoded.id,
    invoice,
    transactionId: event.TransactionId,
    amount: 0n,
    discountBps: 0,
    symbol: event.Token ?? '',
    expiresAt: 0n,
  });
}

async function apply(ctx: WebhookContext, session: Session, event: MeshWebhookEvent): Promise<void> {
  const { sessions, client } = ctx;
  const id = session.id;
  const attention = (reason: string) => void sessions.update(id, { state: 'needs-attention', reason });

  switch (event.TransferStatus) {
    case 'Pending':
      if (session.state === 'awaiting-transfer') sessions.update(id, { state: 'pending' });
      return;
    case 'Failed':
      if (session.state === 'awaiting-transfer' || session.state === 'pending') sessions.update(id, { state: 'failed' });
      return;
    case 'Succeeded':
      break;
    default:
      return;
  }
  if (session.state === 'settled') return;

  const txHash = event.TxHash ? (event.TxHash as Hash) : undefined;
  sessions.update(id, {
    state: 'succeeded',
    reason: undefined,
    transferTx: txHash ?? session.transferTx,
    payer: { provider: event.SourceAccountProvider, sourceAddress: event.SourceAddress, refundAddress: event.RefundAddress },
  });

  if (event.DestinationAddress?.toLowerCase() !== session.invoice.toLowerCase()) return attention('destination mismatch');
  if (event.Chain !== ctx.chainName) return attention('chain mismatch');

  // Wait for the reported transfer, but don't trust it either way: the balance below decides.
  if (txHash) await waitForTransactionReceipt(client, { hash: txHash, timeout: ctx.receiptTimeoutMs }).catch(() => undefined);

  const invoice = await readInvoice(client, session.invoice);
  if (event.Token !== ctx.meshTokens[getAddress(invoice.token)]) return attention('token mismatch');
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
