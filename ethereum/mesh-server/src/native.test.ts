// Native ETH (T2): tokenBalance / tokenDecimals / NATIVE_TOKEN, the mesh-session route and the completed webhook
// for an ETH invoice (token == address(0)). Spec: ethereum/docs/spec/native-eth-spec.md section 5.
import { describe, expect, it } from 'vitest';
import { formatUnits, getAddress, type Address } from 'viem';
import { createApp } from './app';
import {
  CLONE,
  FACTORY,
  MESH_BASE_URL,
  MESH_CLIENT_ID,
  MESH_CLIENT_SECRET,
  NETWORK_CAIP2,
  PYUSD,
  SESSION_ID,
  T,
  WEBHOOK_SECRET,
  ZERO,
  fakeClient,
  fakeMesh,
  fakeSettle,
  makeWorld,
  txHashOf,
  txId,
  webhookEvent,
  type EventOptions,
  type FakeSettleOptions,
  type InvoiceFixture,
} from './fakeChain';
import { NATIVE_TOKEN, tokenBalance, tokenDecimals } from './invoice';
import { SessionStore } from './sessions';
import { createEventProcessor, type MeshWebhookEvent } from './webhook';

// Default tiers (fakeChain): quote window picks 10%; activeDiscount(T) is 15%.
const ONE_AND_A_HALF_ETH = 1_500_000_000_000_000_000n; // quote 1.35 ETH, due now 1.275 ETH
const ETH_INVOICE = { token: ZERO, principal: ONE_AND_A_HALF_ETH };
const DUE_NOW = 1_275_000_000_000_000_000n;
const HOLDER: Address = '0x00000000000000000000000000000000000000dd';

describe('NATIVE_TOKEN', () => {
  it('is the zero address', () => {
    expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('tokenBalance (native ETH)', () => {
  it('reads the ETH balance of the holder with eth_getBalance', async () => {
    const log: string[] = [];
    const client = fakeClient({ log, ethBalance: (a) => (a.toLowerCase() === HOLDER ? 5_000_000_000_000_000_001n : undefined) });
    expect(await tokenBalance(client, NATIVE_TOKEN, HOLDER)).toBe(5_000_000_000_000_000_001n);
    expect(await tokenBalance(client, NATIVE_TOKEN, CLONE)).toBe(0n);
    expect(log).toContain('eth_getBalance');
    expect(log).not.toContain('eth_call');
  });

  it('reads the balance of an ETH clone, and makes no ERC-20 call', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { token: ZERO, balance: 3n * 10n ** 18n } } });
    expect(await tokenBalance(world.client, NATIVE_TOKEN, CLONE)).toBe(3n * 10n ** 18n);
    expect(world.erc20Calls).toEqual([]);
  });

  it('compares the token address case-insensitively (a mixed-case zero address is the same)', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { token: ZERO, balance: 42n } } });
    expect(await tokenBalance(world.client, '0X0000000000000000000000000000000000000000' as Address, CLONE)).toBe(42n);
    expect(world.erc20Calls).toEqual([]);
  });

  it('still reads ERC-20 balanceOf for a token, not eth_getBalance', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { balance: 7_654_321n } } });
    expect(await tokenBalance(world.client, PYUSD, CLONE)).toBe(7_654_321n);
    expect(world.erc20Calls).toEqual(['balanceOf']);
    expect(world.log).not.toContain('eth_getBalance');
  });
});

describe('tokenDecimals', () => {
  it('is 18 for native ETH, with no chain call at all', async () => {
    const log: string[] = [];
    const client = fakeClient({ log });
    expect(await tokenDecimals(client, NATIVE_TOKEN)).toBe(18);
    expect(log).toEqual([]);
  });

  it('reads decimals() on an ERC-20', async () => {
    const world = makeWorld();
    world.decimals[PYUSD.toLowerCase()] = 8;
    expect(await tokenDecimals(world.client, PYUSD)).toBe(8);
    expect(world.erc20Calls).toEqual(['decimals']);
  });

  it('defaults to the 6 decimals of the PYUSD fixture', async () => {
    expect(await tokenDecimals(makeWorld().client, PYUSD)).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------

function setupApp(opts: { invoice?: Partial<InvoiceFixture>; meshTokens?: Record<Address, string> } = {}) {
  const world = makeWorld({ invoices: { [CLONE]: { ...ETH_INVOICE, ...opts.invoice } } });
  const fetch = fakeMesh();
  const settle = fakeSettle(world);
  const built = createApp({
    allowedOrigin: 'http://localhost:5173',
    client: world.client,
    factory: FACTORY,
    meshApi: { baseUrl: MESH_BASE_URL, clientId: MESH_CLIENT_ID, clientSecret: MESH_CLIENT_SECRET, fetch },
    linkEnvironment: 'sbx',
    meshTokens: opts.meshTokens ?? { [ZERO]: 'ETH', [getAddress(PYUSD)]: 'PYUSD' },
    networkCaip2: NETWORK_CAIP2,
    webhookSecret: WEBHOOK_SECRET,
    settle,
    receiptTimeoutMs: 100,
  });
  const post = (address: string) => built.app.request(`/invoices/${address}/mesh-session`, { method: 'POST' });
  return { world, fetch, settle, ...built, post };
}

describe('POST /invoices/:address/mesh-session for an ETH invoice', () => {
  it('is 201 with symbol ETH and an 18-decimal display amount', async () => {
    const t = setupApp();
    const res = await t.post(CLONE);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      linkToken: 'lt_test_token',
      clientId: MESH_CLIENT_ID,
      linkEnvironment: 'sbx',
      amount: '1350000000000000000',
      displayAmount: '1.35',
      symbol: 'ETH',
      discountBps: 1000,
      expiresAt: Number(T) + 600,
    });
    expect(formatUnits(1_350_000_000_000_000_000n, 18)).toBe('1.35');
  });

  it('sends symbol ETH, the network and the 18-decimal amount string to Mesh', async () => {
    const t = setupApp();
    const body = (await (await t.post(CLONE)).json()) as { id: string };
    expect(JSON.parse(t.fetch.sessions[0].body!)).toEqual({
      userId: `buyer-${body.id}`,
      transferOptions: {
        type: 'TRANSFER_TYPE_PAYMENT',
        clientTransactionId: `${CLONE.toLowerCase()}-${body.id}`,
        toAddresses: [{ networkCaip2: NETWORK_CAIP2, symbol: 'ETH', address: getAddress(CLONE), amount: '1.35' }],
      },
    });
  });

  it('keeps every fractional digit: 1.234567890123456789 ETH less a floored 10%', async () => {
    const t = setupApp({ invoice: { principal: 1_234_567_890_123_456_789n } });
    const body = await (await t.post(CLONE)).json();
    // discount = floor(1234567890123456789 * 1000 / 10000) = 123456789012345678
    expect(body).toMatchObject({ amount: '1111111101111111111', displayAmount: '1.111111101111111111', symbol: 'ETH' });
    expect(JSON.parse(t.fetch.sessions[0].body!).transferOptions.toAddresses[0].amount).toBe('1.111111101111111111');
  });

  it('shows a sub-gwei amount in full', async () => {
    const t = setupApp({ invoice: { principal: 3n, tiers: [] } });
    expect(await (await t.post(CLONE)).json()).toMatchObject({ amount: '3', displayAmount: '0.000000000000000003' });
  });

  it('makes no ERC-20 call for an ETH invoice (decimals is 18 without asking the chain)', async () => {
    const t = setupApp();
    await t.post(CLONE);
    expect(t.world.erc20Calls).toEqual([]);
  });

  it('is 422 when meshTokens has no entry for the zero address', async () => {
    const t = setupApp({ meshTokens: { [getAddress(PYUSD)]: 'PYUSD' } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { token: string }).token).toBe(ZERO);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('is 409 already paid when the clone ETH balance covers the amount due now', async () => {
    const t = setupApp({ invoice: { balance: DUE_NOW } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already paid', balance: DUE_NOW.toString(), due: DUE_NOW.toString() });
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('starts a session when the ETH balance is one wei below the amount due', async () => {
    const t = setupApp({ invoice: { balance: DUE_NOW - 1n } });
    expect((await t.post(CLONE)).status).toBe(201);
  });

  it('answers 409 with the status for a non-Active ETH invoice, before the token check', async () => {
    const t = setupApp({ invoice: { status: 1 }, meshTokens: {} });
    const res = await t.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'Funded' });
  });
});

// ---------------------------------------------------------------------------------------------------------------

// A webhook processor over an ETH invoice (principal 1.5 ETH, due now 1.275 ETH) with a known ETH session.
function setupHook(opts: { invoice?: Partial<InvoiceFixture>; settle?: FakeSettleOptions } = {}) {
  const world = makeWorld({ invoices: { [CLONE]: { ...ETH_INVOICE, balance: DUE_NOW, ...opts.invoice } } });
  const sessions = new SessionStore();
  const settle = fakeSettle(world, opts.settle);
  sessions.create({
    id: SESSION_ID,
    invoice: CLONE,
    transactionId: txId(CLONE),
    amount: 1_350_000_000_000_000_000n,
    discountBps: 1000,
    symbol: 'ETH',
    expiresAt: T + 600n,
  });
  const process = createEventProcessor({
    client: world.client,
    factory: FACTORY,
    sessions,
    meshTokens: { [ZERO]: 'ETH', [getAddress(PYUSD)]: 'PYUSD' },
    networkCaip2: NETWORK_CAIP2,
    settle,
    receiptTimeoutMs: 150,
  });
  const event = (o: EventOptions = {}): MeshWebhookEvent => {
    const e = webhookEvent({ ...o, dest: { asset: { symbol: 'ETH', decimals: 18 }, ...o.dest } });
    world.receipts[txHashOf(e)] = { status: 'success' };
    return e;
  };
  return { world, sessions, settle, process, event, session: () => sessions.get(SESSION_ID)! };
}

describe('completed webhook on an ETH invoice', () => {
  it('settles when the ETH balance covers the amount due', async () => {
    const t = setupHook();
    await t.process(t.event());
    expect(t.settle.state.calls).toEqual([CLONE]);
    expect(t.session().state).toBe('settled');
    expect(t.session().settleTx).toBe(t.settle.state.hashes[0]);
    expect(t.world.erc20Calls).toEqual([]);
  });

  it('settles when the ETH balance exceeds the amount due', async () => {
    const t = setupHook({ invoice: { balance: DUE_NOW + 1n } });
    await t.process(t.event());
    expect(t.session().state).toBe('settled');
  });

  it('settles when the event carries no symbol at all (the check is "when present")', async () => {
    const t = setupHook();
    await t.process(t.event({ dest: { asset: undefined } }));
    expect(t.session().state).toBe('settled');
  });

  it('needs attention, with the balance and the due amount, when the ETH balance is one wei short', async () => {
    const t = setupHook({ invoice: { balance: DUE_NOW - 1n } });
    await t.process(t.event());
    expect(t.settle.state.calls).toEqual([]);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe(`insufficient balance: ${DUE_NOW - 1n} < ${DUE_NOW}`);
  });

  it('needs attention on a zero ETH balance', async () => {
    const t = setupHook({ invoice: { balance: 0n } });
    await t.process(t.event());
    expect(t.settle.state.calls).toEqual([]);
    expect(t.session().reason).toBe(`insufficient balance: 0 < ${DUE_NOW}`);
  });

  it.each(['PYUSD', 'USDG', 'eth'])('refuses a "%s" payment to an ETH invoice as a token mismatch', async (symbol) => {
    const t = setupHook();
    await t.process(t.event({ dest: { asset: { symbol, decimals: 18 } } }));
    expect(t.settle.state.calls).toEqual([]);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('token mismatch');
  });

  it('refuses an ETH payment to a PYUSD invoice as a token mismatch', async () => {
    const t = setupHook({ invoice: { token: PYUSD, principal: 100_000_000n, balance: 90_000_000n } });
    await t.process(t.event({ dest: { asset: { symbol: 'ETH', decimals: 18 } } }));
    expect(t.settle.state.calls).toEqual([]);
    expect(t.session().state).toBe('needs-attention');
    expect(t.session().reason).toBe('token mismatch');
  });

  it('still settles a PYUSD invoice on a PYUSD event (ERC-20 balance path)', async () => {
    const t = setupHook({ invoice: { token: PYUSD, principal: 100_000_000n, balance: 85_000_000n } });
    await t.process(t.event({ dest: { asset: { symbol: 'PYUSD', decimals: 6 } } }));
    expect(t.session().state).toBe('settled');
    expect(t.world.erc20Calls).toContain('balanceOf');
  });
});
