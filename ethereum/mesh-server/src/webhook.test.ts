import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, getAddress, type Address } from 'viem';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import {
  CHAIN_NAME,
  CLONE,
  CLONE_B,
  FACTORY,
  NOT_CLONE,
  PYUSD,
  SESSION_ID,
  SESSION_ID_2,
  T,
  deferred,
  fakeSettle,
  makeWorld,
  newHash,
  txId,
  webhookEvent,
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
      sessions.create({
        id: i === 0 ? SESSION_ID : SESSION_ID_2,
        invoice: address as Address,
        transactionId: txId(address as Address, i === 0 ? SESSION_ID : SESSION_ID_2),
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
    chainName: CHAIN_NAME,
    settle,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 150,
  });
  /** A webhook event whose inbound TxHash receipt exists on the fake chain (unless a TxHash is given). */
  const event = (overrides: Record<string, unknown> = {}, invoice: Address = CLONE, id: string = SESSION_ID): MeshWebhookEvent => {
    const e = webhookEvent({ TransactionId: txId(invoice, id), ...overrides }, invoice);
    if (!('TxHash' in overrides) && e.TxHash) world.receipts[e.TxHash] = { status: 'success' };
    return e as MeshWebhookEvent;
  };
  const session = (id: string = SESSION_ID) => sessions.get(id)!;
  return { world, sessions, settle, process, event, session };
}

const waitFor = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe('createEventProcessor: settling', () => {
  it('settles on Succeeded when the balance covers the amount due', async () => {
    const t = setup();
    const event = t.event();
    await t.process(event);
    expect(t.settle.state.calls).toEqual([getAddress(CLONE)]);
    const s = t.session();
    expect(s.state).toBe('settled');
    expect(s.settleTx).toBe(t.settle.state.hashes[0]);
    expect(s.transferTx).toBe(event.TxHash);
    expect(s.payer).toEqual({
      provider: 'Coinbase',
      sourceAddress: '0x00000000000000000000000000000000000000c1',
      refundAddress: '0x00000000000000000000000000000000000000c2',
    });
    expect(s.reason).toBeUndefined();
  });

  it('settles when the balance equals the amount due exactly', async () => {
    const t = setup({ invoice: { balance: 85_000_000n } });
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });

  it('settles when the balance exceeds the amount due', async () => {
    const t = setup({ invoice: { balance: 500_000_000n } });
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });

  it('matches DestinationAddress case-insensitively', async () => {
    const t = setup();
    await t.process(t.event({ DestinationAddress: CLONE.toUpperCase().replace('0X', '0x') }));
    expect(t.session().state).toBe('settled');
  });

  it('settles from the chain when the inbound receipt is not found (balance decides)', async () => {
    const t = setup({ receiptTimeoutMs: 100 });
    await t.process(t.event({ TxHash: newHash() }));
    expect(t.settle.state.calls).toHaveLength(1);
    expect(t.session().state).toBe('settled');
  });

  it('settles when the inbound receipt reverted (balance decides)', async () => {
    const t = setup();
    const TxHash = newHash();
    t.world.receipts[TxHash] = { status: 'reverted' };
    await t.process(t.event({ TxHash }));
    expect(t.session().state).toBe('settled');
  });

  it('settles when the event has no TxHash, and records no transferTx', async () => {
    const t = setup();
    await t.process(t.event({ TxHash: undefined }));
    expect(t.session().state).toBe('settled');
    expect(t.session().transferTx).toBeUndefined();
  });

  it('waits for an inbound receipt that appears late', async () => {
    const t = setup({ receiptTimeoutMs: 2000 });
    const TxHash = newHash();
    setTimeout(() => (t.world.receipts[TxHash] = { status: 'success' }), 40);
    const started = Date.now();
    await t.process(t.event({ TxHash }));
    expect(t.session().state).toBe('settled');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // SPEC-QUESTION 1
  it('settles a 100% discount invoice with a zero due amount only if the balance is positive', async () => {
    const tiers = [{ cutoff: T + 5000n, discountBps: 10_000 }];
    const funded = setup({ invoice: { tiers, balance: 1n } });
    await funded.process(funded.event());
    expect(funded.session().state).toBe('settled');
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
    expect(t.session().payer?.provider).toBe('Coinbase');
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

  it('refuses a destination mismatch', async () => {
    const t = setup();
    await t.process(t.event({ DestinationAddress: CLONE_B }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('destination mismatch');
  });

  it('refuses a chain mismatch', async () => {
    const t = setup();
    await t.process(t.event({ Chain: 'Ethereum' }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('chain mismatch');
  });

  it('refuses a missing Chain or DestinationAddress', async () => {
    const t = setup();
    await t.process(t.event({ Chain: undefined }));
    await t.process(t.event({ DestinationAddress: undefined }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
  });

  it('refuses a token mismatch', async () => {
    const t = setup();
    await t.process(t.event({ Token: 'USDG' }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('token mismatch');
  });

  it('refuses when the invoice token is not a Mesh token at all', async () => {
    const t = setup({ invoice: { token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' } });
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

  it('can settle on a later event once the balance has arrived', async () => {
    const t = setup({ invoice: { balance: 10n } });
    await t.process(t.event());
    expect(t.session().state).toBe('needs-attention');
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
    expect(t.settle.state.calls).toHaveLength(1);
  });

  it('ignores a Succeeded event for an already settled session', async () => {
    const t = setup();
    await t.process(t.event());
    const settleTx = t.session().settleTx;
    await t.process(t.event());
    expect(t.settle.state.calls).toHaveLength(1);
    expect(t.session().state).toBe('settled');
    expect(t.session().settleTx).toBe(settleTx);
  });

  // SPEC-QUESTION 5
  it('settles on Succeeded after a Failed event', async () => {
    const t = setup();
    await t.process(t.event({ TransferStatus: 'Failed', TxHash: null }));
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

  it('does not mark succeeded sessions settled before settle returns', async () => {
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

describe('createEventProcessor: other statuses', () => {
  it('Pending moves awaiting-transfer to pending', async () => {
    const t = setup();
    await t.process(t.event({ TransferStatus: 'Pending', TxHash: null }));
    expect(t.session().state).toBe('pending');
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it('Failed moves awaiting-transfer and pending to failed', async () => {
    const a = setup();
    await a.process(a.event({ TransferStatus: 'Failed', TxHash: null }));
    expect(a.session().state).toBe('failed');
    const b = setup();
    await b.process(b.event({ TransferStatus: 'Pending', TxHash: null }));
    await b.process(b.event({ TransferStatus: 'Failed', TxHash: null }));
    expect(b.session().state).toBe('failed');
    expect(b.settle.state.calls).toHaveLength(0);
  });

  it('Pending and Failed leave other states as they are', async () => {
    const t = setup();
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
    await t.process(t.event({ TransferStatus: 'Pending', TxHash: null }));
    expect(t.session().state).toBe('settled');
    await t.process(t.event({ TransferStatus: 'Failed', TxHash: null }));
    expect(t.session().state).toBe('settled');

    const n = setup({ invoice: { balance: 1n } });
    await n.process(n.event());
    expect(n.session().state).toBe('needs-attention');
    await n.process(n.event({ TransferStatus: 'Failed', TxHash: null }));
    expect(n.session().state).toBe('needs-attention');
    await n.process(n.event({ TransferStatus: 'Pending', TxHash: null }));
    expect(n.session().state).toBe('needs-attention');
  });

  it('Pending then Succeeded reaches settled, even sent back to back', async () => {
    const t = setup();
    const a = t.process(t.event({ TransferStatus: 'Pending', TxHash: null }));
    const b = t.process(t.event());
    await Promise.all([a, b]);
    expect(t.session().state).toBe('settled');
    expect(t.settle.state.calls).toHaveLength(1);
  });

  it('Succeeded alone reaches settled', async () => {
    const t = setup();
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });

  it('ignores any other TransferStatus', async () => {
    const t = setup();
    for (const TransferStatus of ['RefundPending', 'RefundSucceeded', 'succeeded', '', 'Unknown']) {
      await t.process(t.event({ TransferStatus, TxHash: null }));
    }
    expect(t.session().state).toBe('awaiting-transfer');
    expect(t.settle.state.calls).toHaveLength(0);
  });
});

describe('createEventProcessor: deduplication', () => {
  it('handles an EventId once: settle is called once for two deliveries', async () => {
    const t = setup();
    const event = t.event();
    await t.process(event);
    await t.process({ ...event });
    expect(t.settle.state.calls).toHaveLength(1);
  });

  it('dedups a delivery that arrives while the first is still being processed', async () => {
    const gate = deferred();
    const t = setup({ settle: { gate: gate.promise } });
    const event = t.event();
    const first = t.process(event);
    const second = t.process({ ...event });
    await waitFor(() => t.settle.state.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    await Promise.all([first, second]);
    expect(t.settle.state.calls).toHaveLength(1);
  });

  // SPEC-QUESTION 4
  it('dedups a refused event too: a retry does not re-evaluate', async () => {
    const t = setup({ invoice: { balance: 1n } });
    const event = t.event();
    await t.process(event);
    expect(t.session().state).toBe('needs-attention');
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process({ ...event });
    expect(t.session().state).toBe('needs-attention');
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it('treats different EventIds as different events', async () => {
    const t = setup({ invoice: { balance: 1n } });
    await t.process(t.event({ EventId: 'a' }));
    t.world.invoice(CLONE).balance = 90_000_000n;
    await t.process(t.event({ EventId: 'b' }));
    expect(t.session().state).toBe('settled');
  });
});

describe('createEventProcessor: unknown sessions', () => {
  it('creates a session for a decodable TransactionId of a clone, and settles from the chain', async () => {
    const t = setup({ known: false });
    expect(t.sessions.byTransactionId(txId(CLONE))).toBeUndefined();
    const event = t.event();
    await t.process(event);
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

  it('decodes an upper-case TransactionId', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ TransactionId: `0x${CLONE.slice(2).toUpperCase()}-${SESSION_ID.toUpperCase()}` }));
    expect(t.sessions.forInvoice(CLONE)).toHaveLength(1);
    expect(t.sessions.forInvoice(CLONE)[0].state).toBe('settled');
  });

  it('creates a session with an empty symbol when Token is absent', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ Token: undefined, TransferStatus: 'Pending', TxHash: null }));
    const s = t.sessions.forInvoice(CLONE)[0];
    expect(s.symbol).toBe('');
    expect(s.state).toBe('pending');
  });

  it('refuses an unknown session whose event does not match, but still records it', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ Chain: 'Base' }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(CLONE)[0].state).toBe('needs-attention');
  });

  it('ignores a decodable TransactionId whose invoice is not a clone', async () => {
    const t = setup({ known: false });
    await t.process(t.event({ TransactionId: txId(NOT_CLONE), DestinationAddress: NOT_CLONE }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(NOT_CLONE)).toEqual([]);
    expect(t.sessions.byTransactionId(txId(NOT_CLONE))).toBeUndefined();
  });

  it('ignores a decodable TransactionId of an address with no code', async () => {
    const t = setup({ known: false });
    const nowhere: Address = '0x00000000000000000000000000000000000000cc';
    await t.process(t.event({ TransactionId: txId(nowhere), DestinationAddress: nowhere }));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.forInvoice(nowhere)).toEqual([]);
  });

  it.each(['', 'garbage', `${CLONE}`, `${CLONE}-123`, `${CLONE}-0123456789abcdeg`, `${CLONE}-${SESSION_ID}-x`])(
    'ignores an undecodable TransactionId %j',
    async (TransactionId) => {
      const t = setup({ known: false });
      await expect(t.process(t.event({ TransactionId }))).resolves.toBeUndefined();
      expect(t.settle.state.calls).toHaveLength(0);
      expect(t.sessions.forInvoice(CLONE)).toEqual([]);
    },
  );

  it('never rejects on an event with missing fields', async () => {
    const t = setup();
    for (const e of [{}, { EventId: 'x' }, { EventId: 'y', TransactionId: 5 }, { EventId: 'z', TransactionId: txId(CLONE) }]) {
      await expect(t.process(e as unknown as MeshWebhookEvent)).resolves.toBeUndefined();
    }
    expect(t.settle.state.calls).toHaveLength(0);
  });
});

describe('createEventProcessor: serialization', () => {
  it('never calls settle concurrently for one invoice, and handles events in arrival order', async () => {
    const t = setup({ settle: { delayMs: 40 } });
    // A second session on the same invoice.
    t.sessions.create({
      id: SESSION_ID_2,
      invoice: CLONE,
      transactionId: txId(CLONE, SESSION_ID_2),
      amount: 90_000_000n,
      discountBps: 1000,
      symbol: 'PYUSD',
      expiresAt: T + 600n,
    });
    const a = t.process(t.event());
    const b = t.process(t.event({}, CLONE, SESSION_ID_2));
    const c = t.process(t.event({ TransferStatus: 'Pending', TxHash: null }, CLONE, SESSION_ID_2));
    await Promise.all([a, b, c]);
    expect(t.settle.state.calls).toHaveLength(2);
    expect(t.settle.state.maxActive).toBe(1);
    expect(t.session(SESSION_ID).state).toBe('settled');
    expect(t.session(SESSION_ID_2).state).toBe('settled');
  });

  it('does not start the second settle until the first has finished', async () => {
    const gate = deferred();
    const t = setup({ settle: { gate: gate.promise } });
    t.sessions.create({
      id: SESSION_ID_2,
      invoice: CLONE,
      transactionId: txId(CLONE, SESSION_ID_2),
      amount: 90_000_000n,
      discountBps: 1000,
      symbol: 'PYUSD',
      expiresAt: T + 600n,
    });
    const a = t.process(t.event());
    const b = t.process(t.event({}, CLONE, SESSION_ID_2));
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
    const a = t.process(t.event({}, CLONE, SESSION_ID));
    const b = t.process(t.event({}, CLONE_B, SESSION_ID_2));
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
    const next = t.event();
    await t.process(next);
    expect(t.settle.state.calls).toHaveLength(2);
  });
});
