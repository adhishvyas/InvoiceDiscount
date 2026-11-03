import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, getAddress, type Address } from 'viem';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import {
  CLONE,
  CLONE_B,
  FACTORY,
  NETWORK_CAIP2,
  NOT_CLONE,
  PYUSD,
  SESSION_ID,
  SESSION_ID_2,
  T,
  USDC,
  deferred,
  fakeSettle,
  makeWorld,
  newHash,
  txHashOf,
  txId,
  webhookEvent,
  type EventOptions,
  type FakeSettleOptions,
  type InvoiceFixture,
} from './fakeChain';
import { SessionStore } from './sessions';
import { createEventProcessor, type MeshWebhookEvent } from './webhook';

// Default world: a PYUSD invoice of 100e6, 15% at T (due now 85e6), balance 90e6 (covers the due amount).
function setup(
  opts: { invoice?: Partial<InvoiceFixture>; settle?: FakeSettleOptions; known?: boolean; receiptTimeoutMs?: number; invoices?: Record<Address, Partial<InvoiceFixture>> } = {},
) {
  const world = makeWorld({ invoices: opts.invoices ?? { [CLONE]: { balance: 90_000_000n, ...opts.invoice } } });
  const sessions = new SessionStore();
  const settle = fakeSettle(world, opts.settle);
  if (opts.known !== false) {
    for (const [i, address] of Object.keys(world.invoices).entries()) {
      const id = i === 0 ? SESSION_ID : SESSION_ID_2;
      sessions.create({
        id,
        invoice: address as Address,
        transactionId: txId(address as Address, id),
        amount: 90_000_000n,
        discountBps: 1000,
        symbol: 'PYUSD',
        expiresAt: T + 600n,
      });
    }
  }
  const process = createEventProcessor({
    client: world.client,
    factory: FACTORY,
    sessions,
    meshTokens: { [getAddress(PYUSD)]: 'PYUSD' },
    networkCaip2: NETWORK_CAIP2,
    settle,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 150,
  });
  /** A webhook event whose inbound tx_hash receipt exists on the fake chain (unless `dest.tx_hash` is given). */
  const event = (o: EventOptions = {}): MeshWebhookEvent => {
    const e = webhookEvent(o);
    const hash = txHashOf(e);
    if (hash && !('tx_hash' in (o.dest ?? {}))) world.receipts[hash] = { status: 'success' };
    return e;
  };
  const session = (id: string = SESSION_ID) => sessions.get(id)!;
  return { world, sessions, settle, process, event, session };
}

const waitFor = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe('createEventProcessor: filtering', () => {
  it.each([
    ['version 2', { envelope: { version: '2' } }],
    ['no version', { envelope: { version: undefined } }],
    ['a numeric version', { envelope: { version: 1 } }],
    ['a type that is not transfer.*', { type: 'payment.completed' }],
    ['the bare type "transfer"', { type: 'transfer' }],
    ['no type', { envelope: { type: undefined } }],
    ['no data', { envelope: { data: undefined } }],
    ['no data.transfer', { envelope: { data: { previous_status: 'pending' } } }],
    ['a null data.transfer', { envelope: { data: { transfer: null } } }],
    ['a string data.transfer', { envelope: { data: { transfer: 'completed' } } }],
    ['no event_id', { envelope: { event_id: undefined } }],
    ['an empty event_id', { envelope: { event_id: '' } }],
    ['a numeric event_id', { envelope: { event_id: 7 } }],
  ] as [string, EventOptions][])('ignores an event with %s', async (_name, o) => {
    const t = setup();
    await expect(t.process(t.event(o))).resolves.toBeUndefined();
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('awaiting-transfer');
  });

  it('does not create a session for a filtered event', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ envelope: { version: '2' } }));
    expect(t.sessions.forInvoice(CLONE)).toEqual([]);
  });

  it('records no EventId for a filtered event: the same event_id is processed once it is valid', async () => {
    const t = setup();
    const bad = t.event({ envelope: { version: '2', event_id: 'same' } });
    await t.process(bad);
    expect(t.session().state).toBe('awaiting-transfer');
    await t.process(t.event({ envelope: { event_id: 'same' } }));
    expect(t.session().state).toBe('settled');
  });

  it('accepts any transfer.* type and branches on the status, not the type', async () => {
    for (const type of ['transfer.pending', 'transfer.failed', 'transfer.status_updated', 'transfer.something_new']) {
      const t = setup();
      await t.process(t.event({ type })); // status is "completed" in each
      expect(t.session().state).toBe('settled');
    }
  });

  it('a transfer.completed type with a pending status only marks pending', async () => {
    const t = setup();
    await t.process(t.event({ status: 'pending', type: 'transfer.completed' }));
    expect(t.session().state).toBe('pending');
    expect(t.settle.state.calls).toHaveLength(0);
  });
});

describe('createEventProcessor: settling a completed transfer', () => {
  it('settles when the balance covers the amount due', async () => {
    const t = setup();
    const event = t.event();
    await t.process(event);
    expect(t.settle.state.calls).toEqual([getAddress(CLONE)]);
    const s = t.session();
    expect(s.state).toBe('settled');
    expect(s.settleTx).toBe(t.settle.state.hashes[0]);
    expect(s.transferTx).toBe(txHashOf(event));
    expect(s.payer).toEqual({ provider: 'metamask', sourceAddress: '0x00000000000000000000000000000000000000c1' });
    expect(s.reason).toBeUndefined();
  });

  it('settles when the balance equals the amount due exactly, or exceeds it', async () => {
    const exact = setup({ invoice: { balance: 85_000_000n } });
    await exact.process(exact.event());
    expect(exact.session().state).toBe('settled');
    const more = setup({ invoice: { balance: 500_000_000n } });
    await more.process(more.event());
    expect(more.session().state).toBe('settled');
  });

  it('matches the destination address case-insensitively', async () => {
    const t = setup();
    await t.process(t.event({ dest: { address: CLONE.toLowerCase() } }));
    expect(t.session().state).toBe('settled');
    const u = setup();
    await u.process(u.event({ dest: { address: `0x${CLONE.slice(2).toUpperCase()}` } }));
    expect(u.session().state).toBe('settled');
  });

  it('settles from the chain when the inbound receipt is not found (balance decides)', async () => {
    const t = setup({ receiptTimeoutMs: 100 });
    await t.process(t.event({ dest: { tx_hash: newHash() } }));
    expect(t.settle.state.calls).toHaveLength(1);
    expect(t.session().state).toBe('settled');
  });

  it('settles when the inbound receipt reverted (balance decides)', async () => {
    const t = setup();
    const tx_hash = newHash();
    t.world.receipts[tx_hash] = { status: 'reverted' };
    await t.process(t.event({ dest: { tx_hash } }));
    expect(t.session().state).toBe('settled');
  });

  it('settles when the destination has no tx_hash, and records no transferTx', async () => {
    const t = setup();
    await t.process(t.event({ dest: { tx_hash: undefined } }));
    expect(t.session().state).toBe('settled');
    expect(t.session().transferTx).toBeUndefined();
  });

  it('waits for an inbound receipt that appears late', async () => {
    const t = setup({ receiptTimeoutMs: 2000 });
    const tx_hash = newHash();
    setTimeout(() => (t.world.receipts[tx_hash] = { status: 'success' }), 40);
    const started = Date.now();
    await t.process(t.event({ dest: { tx_hash } }));
    expect(t.session().state).toBe('settled');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // SPEC-QUESTION 1
  it('settles a 100% discount invoice with a zero due amount if the balance is positive', async () => {
    const t = setup({ invoice: { tiers: [{ cutoff: T + 5000n, discountBps: 10_000 }], balance: 1n } });
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });

  it('settles when the destination carries no network or symbol (both are checked only when present)', async () => {
    const t = setup();
    await t.process(t.event({ dest: { network_caip2: undefined, asset: undefined } }));
    expect(t.session().state).toBe('settled');
  });

  it('settles when the asset has no symbol', async () => {
    const t = setup();
    await t.process(t.event({ dest: { asset: { decimals: 6 } } }));
    expect(t.session().state).toBe('settled');
  });

  it('ignores a Succeeded-like event for an already settled session', async () => {
    const t = setup();
    await t.process(t.event());
    const settleTx = t.session().settleTx;
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(1);
    expect(t.session().state).toBe('settled');
    expect(t.session().settleTx).toBe(settleTx);
  });
});

describe('createEventProcessor: payer', () => {
  it('takes the provider from source.crypto.venue and the address from source.crypto.address', async () => {
    const t = setup();
    await t.process(t.event({ src: { venue: 'coinbase', address: '0x00000000000000000000000000000000000000d9' } }));
    expect(t.session().payer).toEqual({ provider: 'coinbase', sourceAddress: '0x00000000000000000000000000000000000000d9' });
  });

  it('falls back to source.kind for the provider when there is no venue', async () => {
    const t = setup();
    await t.process(t.event({ src: { venue: undefined }, srcSide: { kind: 'exchange' } }));
    expect(t.session().payer?.provider).toBe('exchange');
    expect(t.session().payer?.sourceAddress).toBe('0x00000000000000000000000000000000000000c1');
  });

  it('has no source address for an exchange', async () => {
    const t = setup();
    await t.process(t.event({ src: { venue: 'coinbase', address: undefined }, srcSide: { kind: 'exchange' } }));
    expect(t.session().payer?.provider).toBe('coinbase');
    expect(t.session().payer?.sourceAddress).toBeUndefined();
  });

  it('records the payer even when the destination is refused', async () => {
    const t = setup();
    await t.process(t.event({ dest: { address: CLONE_B } }));
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().payer?.provider).toBe('metamask');
    expect(t.session().transferTx).toBeDefined();
  });

  // SPEC-QUESTION 8
  it('still settles when the webhook has no source at all', async () => {
    const t = setup();
    await t.process(t.event({ transfer: { source: undefined } }));
    expect(t.session().state).toBe('settled');
  });
});

describe('createEventProcessor: refusing to settle', () => {
  it('needs attention on an insufficient balance', async () => {
    const t = setup({ invoice: { balance: 84_999_999n } });
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('insufficient balance: 84999999 < 85000000');
    expect(t.session().transferTx).toBeDefined();
  });

  it('needs attention when the balance is 0 even though the amount due is 0', async () => {
    const t = setup({ invoice: { tiers: [{ cutoff: T + 5000n, discountBps: 10_000 }], balance: 0n } });
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('insufficient balance: 0 < 0');
  });

  it('uses the due amount at the latest block timestamp', async () => {
    const t = setup({ invoice: { balance: 85_000_000n } });
    t.world.chain.timestamp = T + 100n; // 10% now: due 90e6
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().reason).toBe('insufficient balance: 85000000 < 90000000');
  });

  it('refuses a destination mismatch, or a missing destination address', async () => {
    const t = setup();
    await t.process(t.event({ dest: { address: CLONE_B } }));
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('destination mismatch');
    const u = setup();
    await u.process(u.event({ dest: { address: undefined } }));
    expect(u.session().reason).toBe('destination mismatch');
    const v = setup();
    await v.process(v.event({ transfer: { destination: undefined } }));
    expect(v.session().state).toBe('needs-attention');
    expect(v.settle.state.calls).toHaveLength(0);
    expect(t.settle.state.calls).toHaveLength(0);
    expect(u.settle.state.calls).toHaveLength(0);
  });

  it('refuses a network mismatch when the network is present', async () => {
    const t = setup();
    await t.process(t.event({ dest: { network_caip2: 'eip155:1' } }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('network mismatch');
  });

  it('refuses a token mismatch when the symbol is present', async () => {
    const t = setup();
    await t.process(t.event({ dest: { asset: { symbol: 'USDG', decimals: 6 } } }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('token mismatch');
  });

  it('refuses a symbol of another case', async () => {
    const t = setup();
    await t.process(t.event({ dest: { asset: { symbol: 'pyusd' } } }));
    expect(t.session().reason).toBe('token mismatch');
  });

  it('refuses a present symbol when the invoice token is not a Mesh token at all', async () => {
    const t = setup({ invoice: { token: USDC } });
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().reason).toBe('token mismatch');
  });

  it('refuses an invoice that is already Paid', async () => {
    const t = setup({ invoice: { status: 2 } });
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('already Paid');
  });

  it.each([
    [1, 'invoice is Funded'],
    [3, 'invoice is Cancelled'],
  ])('refuses an invoice with status %i', async (status, reason) => {
    const t = setup({ invoice: { status } });
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe(reason);
  });

  it('can settle on a later event once the balance has arrived, clearing the reason', async () => {
    const t = setup({ invoice: { balance: 10n } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBeDefined();
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
    expect(t.session().reason).toBeUndefined();
    expect(t.settle.state.calls).toHaveLength(1);
  });

  // SPEC-QUESTION 5
  it('settles a completed event after a failed one', async () => {
    const t = setup();
    await t.process(t.event({ status: 'failed' }));
    expect(t.session().state).toBe('failed');
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });
});

describe('createEventProcessor: settle outcomes', () => {
  it('records the decoded custom error name when settle rejects with a contract revert', async () => {
    const data = encodeErrorResult({ abi: invoiceEscrowAbi, errorName: 'InsufficientDirectPayment', args: [1n, 2n] });
    const revert = new ContractFunctionRevertedError({ abi: invoiceEscrowAbi, data, functionName: 'settleDirect' });
    const error = new ContractFunctionExecutionError(revert, { abi: invoiceEscrowAbi, functionName: 'settleDirect' });
    const t = setup({ settle: { reject: error } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('InsufficientDirectPayment');
    expect(t.session().settleTx).toBeUndefined();
  });

  it("records viem's shortMessage for a viem error without decoded revert data", async () => {
    const error = new BaseError('insufficient funds for gas', { details: 'long details that are not the reason' });
    const t = setup({ settle: { reject: error } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('insufficient funds for gas');
  });

  it("records a plain error's message", async () => {
    const t = setup({ settle: { reject: new Error('nonce too low') } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('nonce too low');
  });

  it('records a reverted settle receipt with its hash', async () => {
    const t = setup({ settle: { receipt: 'reverted' } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('settleDirect reverted');
    expect(t.session().settleTx).toBe(t.settle.state.hashes[0]);
  });

  it('never rejects, and records the error, when a chain read fails', async () => {
    const t = setup();
    t.world.balanceError = 'rpc exploded';
    await expect(t.process(t.event())).resolves.toBeUndefined();
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBeTruthy();
  });

  it('shows succeeded while settle is in flight, then settled', async () => {
    const gate = deferred();
    const t = setup({ settle: { gate: gate.promise } });
    const done = t.process(t.event());
    await waitFor(() => t.settle.state.calls.length === 1);
    expect(t.session().state).toBe('succeeded');
    gate.resolve();
    await done;
    expect(t.session().state).toBe('settled');
  });
});

describe('createEventProcessor: non-terminal and failed statuses', () => {
  it.each(['pending', 'compliance_hold'])('%s moves awaiting-transfer to pending without settling', async (status) => {
    const t = setup();
    await t.process(t.event({ status }));
    expect(t.session().state).toBe('pending');
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it.each(['failed', 'refunded'])('%s moves awaiting-transfer and pending to failed, with the status as the reason', async (status) => {
    const a = setup();
    await a.process(a.event({ status }));
    expect(a.session().state).toBe('failed');
    expect(a.session().reason).toBe(status);
    const b = setup();
    await b.process(b.event({ status: 'pending' }));
    await b.process(b.event({ status }));
    expect(b.session().state).toBe('failed');
    expect(b.settle.state.calls).toHaveLength(0);
  });

  it('prefers error_code, then error_message, then the status, for a failure reason', async () => {
    const both = setup();
    await both.process(both.event({ status: 'failed', transfer: { error_code: 'insufficient_funds', error_message: 'Not enough funds' } }));
    expect(both.session().reason).toBe('insufficient_funds');
    const message = setup();
    await message.process(message.event({ status: 'refunded', transfer: { error_message: 'Sent back' } }));
    expect(message.session().reason).toBe('Sent back');
    const neither = setup();
    await neither.process(neither.event({ status: 'failed' }));
    expect(neither.session().reason).toBe('failed');
  });

  it('compliance_hold after pending stays pending, and after a terminal state changes nothing', async () => {
    const t = setup();
    await t.process(t.event({ status: 'pending' }));
    await t.process(t.event({ status: 'compliance_hold' }));
    expect(t.session().state).toBe('pending');
    await t.process(t.event({ status: 'failed' }));
    await t.process(t.event({ status: 'compliance_hold' }));
    expect(t.session().state).toBe('failed');
  });

  it('a non-terminal or failed status never overwrites settled or needs-attention', async () => {
    const t = setup();
    await t.process(t.event());
    for (const status of ['pending', 'compliance_hold', 'failed', 'refunded']) await t.process(t.event({ status }));
    expect(t.session().state).toBe('settled');
    expect(t.session().reason).toBeUndefined();

    const n = setup({ invoice: { balance: 1n } });
    await n.process(n.event());
    const reason = n.session().reason;
    expect(n.session().state).toBe('needs-attention');
    for (const status of ['pending', 'compliance_hold', 'failed', 'refunded']) await n.process(n.event({ status }));
    expect(n.session().state).toBe('needs-attention');
    expect(n.session().reason).toBe(reason);
  });

  it('pending then completed reaches settled, even sent back to back', async () => {
    const t = setup();
    const a = t.process(t.event({ status: 'pending' }));
    const b = t.process(t.event());
    await Promise.all([a, b]);
    expect(t.session().state).toBe('settled');
    expect(t.settle.state.calls).toHaveLength(1);
  });

  it('ignores any other status', async () => {
    const t = setup();
    for (const status of ['', 'unknown', 'COMPLETED', 'Completed', 'succeeded', 'cancelled']) await t.process(t.event({ status }));
    await t.process(t.event({ transfer: { status: undefined } }));
    expect(t.session().state).toBe('awaiting-transfer');
    expect(t.settle.state.calls).toHaveLength(0);
  });
});

describe('createEventProcessor: deduplication', () => {
  it('handles an event_id once: settle is called once for two deliveries', async () => {
    const t = setup();
    const event = t.event();
    await t.process(event);
    await t.process(JSON.parse(JSON.stringify(event)));
    expect(t.settle.state.calls).toHaveLength(1);
  });

  it('dedups a delivery that arrives while the first is still being processed', async () => {
    const gate = deferred();
    const t = setup({ settle: { gate: gate.promise } });
    const event = t.event();
    const first = t.process(event);
    const second = t.process(JSON.parse(JSON.stringify(event)));
    await waitFor(() => t.settle.state.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    await Promise.all([first, second]);
    expect(t.settle.state.calls).toHaveLength(1);
  });

  // SPEC-QUESTION 4
  it('dedups a refused event too: a redelivery does not re-evaluate', async () => {
    const t = setup({ invoice: { balance: 1n } });
    const event = t.event();
    await t.process(event);
    expect(t.session().state).toBe('needs-attention');
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process(JSON.parse(JSON.stringify(event)));
    expect(t.session().state).toBe('needs-attention');
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it('counts an event ignored for its session as seen', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ envelope: { event_id: 'dup' }, transfer: { client_transaction_id: 'garbage' } }));
    await t.process(t.event({ envelope: { event_id: 'dup' } })); // same event_id, now with a valid transaction id
    expect(t.sessions.forInvoice(CLONE)).toEqual([]);
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it('treats different event_ids as different events', async () => {
    const t = setup({ invoice: { balance: 1n } });
    await t.process(t.event({ envelope: { event_id: 'a' } }));
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process(t.event({ envelope: { event_id: 'b' } }));
    expect(t.session().state).toBe('settled');
  });
});

describe('createEventProcessor: unknown sessions', () => {
  it('creates a session for a decodable client_transaction_id of a clone, and settles from the chain', async () => {
    const t = setup({ known: false });
    expect(t.sessions.byTransactionId(txId(CLONE))).toBeUndefined();
    await t.process(t.event());
    const s = t.sessions.byTransactionId(txId(CLONE));
    expect(s).toBeDefined();
    expect(s!.id).toBe(SESSION_ID);
    expect(s!.invoice).toBe(getAddress(CLONE));
    expect(s!.amount).toBe(0n);
    expect(s!.discountBps).toBe(0);
    expect(s!.expiresAt).toBe(0n);
    expect(s!.symbol).toBe('PYUSD');
    expect(s!.state).toBe('settled');
    expect(t.settle.state.calls).toEqual([getAddress(CLONE)]);
    expect(t.sessions.forInvoice(CLONE)).toHaveLength(1);
  });

  it('decodes an upper-case client_transaction_id', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ transfer: { client_transaction_id: `0x${CLONE.slice(2).toUpperCase()}-${SESSION_ID.toUpperCase()}` } }));
    expect(t.sessions.forInvoice(CLONE)).toHaveLength(1);
    expect(t.sessions.forInvoice(CLONE)[0].state).toBe('settled');
  });

  it('creates a session with an empty symbol when the destination has no asset symbol', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ status: 'pending', dest: { asset: undefined } }));
    const s = t.sessions.forInvoice(CLONE)[0];
    expect(s.symbol).toBe('');
    expect(s.state).toBe('pending');
  });

  it('refuses an unknown session whose event does not match, but still records it', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ dest: { network_caip2: 'eip155:8453' } }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(CLONE)[0].state).toBe('needs-attention');
  });

  it('ignores a decodable client_transaction_id whose invoice is not a clone', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ invoice: NOT_CLONE }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(NOT_CLONE)).toEqual([]);
    expect(t.sessions.byTransactionId(txId(NOT_CLONE))).toBeUndefined();
  });

  it('ignores a decodable client_transaction_id of an address with no code', async () => {
    const t = setup({ known: false });
    const nowhere: Address = '0x00000000000000000000000000000000000000cc';
    await t.process(t.event({ invoice: nowhere }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(nowhere)).toEqual([]);
  });

  it.each(['', 'garbage', `${CLONE}`, `${CLONE}-123`, `${CLONE}-0123456789abcdeg`, `${CLONE}-${SESSION_ID}-x`, undefined, 5, null])(
    'ignores an undecodable or missing client_transaction_id %j',
    async (client_transaction_id) => {
      const t = setup({ known: false });
      await expect(t.process(t.event({ transfer: { client_transaction_id } }))).resolves.toBeUndefined();
      expect(t.settle.state.calls).toHaveLength(0);
      expect(t.sessions.forInvoice(CLONE)).toEqual([]);
    },
  );

  it('never rejects on odd events', async () => {
    const t = setup();
    const odd = [
      {},
      { version: '1' },
      { version: '1', type: 'transfer.completed', event_id: 'x', data: { transfer: {} } },
      { version: '1', type: 'transfer.completed', event_id: 'y', data: { transfer: { status: 'completed', client_transaction_id: txId(CLONE) } } },
      { version: '1', type: 'transfer.completed', event_id: 'z', data: { transfer: { status: 'completed', client_transaction_id: txId(CLONE), destination: 'x', source: 5 } } },
    ];
    for (const e of odd) await expect(t.process(e as unknown as MeshWebhookEvent)).resolves.toBeUndefined();
    expect(t.settle.state.calls).toHaveLength(0);
  });
});

describe('createEventProcessor: serialization', () => {
  const second = (t: ReturnType<typeof setup>) =>
    t.sessions.create({
      id: SESSION_ID_2,
      invoice: CLONE,
      transactionId: txId(CLONE, SESSION_ID_2),
      amount: 90_000_000n,
      discountBps: 1000,
      symbol: 'PYUSD',
      expiresAt: T + 600n,
    });

  it('never calls settle concurrently for one invoice, and handles events in arrival order', async () => {
    const t = setup({ settle: { delayMs: 40 } });
    second(t);
    const a = t.process(t.event());
    const b = t.process(t.event({ sessionId: SESSION_ID_2 }));
    const c = t.process(t.event({ status: 'pending', sessionId: SESSION_ID_2 }));
    await Promise.all([a, b, c]);
    expect(t.settle.state.calls).toHaveLength(2);
    expect(t.settle.state.maxActive).toBe(1);
    expect(t.session(SESSION_ID).state).toBe('settled');
    expect(t.session(SESSION_ID_2).state).toBe('settled');
  });

  it('does not start the second settle until the first has finished', async () => {
    const gate = deferred();
    const t = setup({ settle: { gate: gate.promise } });
    second(t);
    const a = t.process(t.event());
    const b = t.process(t.event({ sessionId: SESSION_ID_2 }));
    await waitFor(() => t.settle.state.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.settle.state.calls).toHaveLength(1);
    gate.resolve();
    await Promise.all([a, b]);
    expect(t.settle.state.calls).toHaveLength(2);
    expect(t.settle.state.maxActive).toBe(1);
  });

  it('runs events for different invoices concurrently', async () => {
    const gate = deferred();
    const t = setup({
      invoices: { [CLONE]: { balance: 90_000_000n }, [CLONE_B]: { balance: 90_000_000n } },
      settle: { gate: gate.promise },
    });
    const a = t.process(t.event({ invoice: CLONE, sessionId: SESSION_ID }));
    const b = t.process(t.event({ invoice: CLONE_B, sessionId: SESSION_ID_2 }));
    await waitFor(() => t.settle.state.calls.length === 2, 800);
    const concurrent = t.settle.state.calls.length;
    gate.resolve();
    await Promise.all([a, b]);
    expect(concurrent).toBe(2);
    expect(t.settle.state.maxActive).toBe(2);
  });

  it('keeps going after an event fails: the next event for the invoice still runs', async () => {
    const t = setup({ settle: { reject: new Error('first fails') } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(2);
  });
});
