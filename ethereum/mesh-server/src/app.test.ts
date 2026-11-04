import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { createApp } from './app';
import {
  CLONE,
  CLONE_B,
  FACTORY,
  MESH_BASE_URL,
  MESH_CLIENT_ID,
  MESH_CLIENT_SECRET,
  NETWORK_CAIP2,
  NOT_CLONE,
  PYUSD,
  SESSION_ID,
  T,
  USDC,
  WEBHOOK_SECRET,
  deferred,
  fakeMesh,
  fakeSettle,
  json,
  makeWorld,
  nowSeconds,
  sign,
  txHashOf,
  txId,
  webhookEvent,
  type EventOptions,
  type FakeMeshOptions,
  type FakeSettleOptions,
  type InvoiceFixture,
} from './fakeChain';

const ORIGIN = 'http://localhost:5173';

function setup(
  opts: {
    invoice?: Partial<InvoiceFixture>;
    invoices?: Record<Address, Partial<InvoiceFixture>>;
    mesh?: FakeMeshOptions;
    settle?: FakeSettleOptions;
  } = {},
) {
  const world = makeWorld({ invoices: opts.invoices ?? { [CLONE]: opts.invoice ?? {} } });
  const fetch = fakeMesh(opts.mesh);
  const settle = fakeSettle(world, opts.settle);
  const built = createApp({
    allowedOrigin: ORIGIN,
    client: world.client,
    factory: FACTORY,
    meshApi: { baseUrl: MESH_BASE_URL, clientId: MESH_CLIENT_ID, clientSecret: MESH_CLIENT_SECRET, fetch },
    linkEnvironment: 'sbx',
    meshTokens: { [getAddress(PYUSD)]: 'PYUSD' },
    networkCaip2: NETWORK_CAIP2,
    webhookSecret: WEBHOOK_SECRET,
    settle,
    receiptTimeoutMs: 100,
  });
  const post = (address: string) => built.app.request(`/invoices/${address}/mesh-session`, { method: 'POST' });
  const get = (address: string, id: string) => built.app.request(`/invoices/${address}/mesh-session/${id}`);
  const list = (address: string) => built.app.request(`/invoices/${address}/mesh-sessions`);
  /**
   * POST /webhooks/mesh. `timestamp` and `signature` default to the current time and a valid signature over it;
   * `null` sends no such header at all.
   */
  const webhook = (body: string, h: { timestamp?: string | null; signature?: string | null } = {}) => {
    const timestamp = h.timestamp === undefined ? String(nowSeconds()) : h.timestamp;
    const signature = h.signature === undefined ? sign(body, timestamp ?? nowSeconds()) : h.signature;
    return built.app.request('/webhooks/mesh', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        ...(timestamp === null ? {} : { 'X-Mesh-Timestamp': timestamp }),
        ...(signature === null ? {} : { 'X-Mesh-Signature-256': signature }),
      },
    });
  };
  /** A webhook event whose inbound receipt exists on the fake chain. */
  const event = (o: EventOptions = {}) => {
    const e = webhookEvent(o);
    world.receipts[txHashOf(e)] = { status: 'success' };
    return e;
  };
  return { world, fetch, settle, ...built, post, get, list, webhook, event };
}

const waitFor = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe('GET /health', () => {
  it('is 200 { ok: true }', async () => {
    const res = await setup().app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('CORS', () => {
  it('allows the configured origin only', async () => {
    const { app } = setup();
    const ok = await app.request('/health', { headers: { Origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const evil = await app.request('/health', { headers: { Origin: 'http://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('http://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('POST /invoices/:address/mesh-session', () => {
  it('is 400 for an invalid address, without calling Mesh', async () => {
    const t = setup();
    for (const bad of ['0x123', 'nope', `${CLONE}00`, CLONE.slice(2)]) expect((await t.post(bad)).status).toBe(400);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('is 404 for an address that is not a clone of the factory implementation', async () => {
    const t = setup();
    expect((await t.post(NOT_CLONE)).status).toBe(404); // a contract that is not a clone
    expect((await t.post('0x00000000000000000000000000000000000000dd')).status).toBe(404); // no code
    expect(t.fetch.calls).toHaveLength(0);
  });

  it.each([
    [1, 'Funded'],
    [2, 'Paid'],
    [3, 'Cancelled'],
  ])('is 409 naming the status for a %i invoice', async (status, name) => {
    const t = setup({ invoice: { status } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: name });
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('is 422 for a token Mesh does not support, such as USDC', async () => {
    const t = setup({ invoice: { token: USDC } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { token: string }).token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('is 409 already paid when the balance covers the amount due now', async () => {
    const t = setup({ invoice: { balance: 85_000_000n } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already paid', balance: '85000000', due: '85000000' });
    expect(t.fetch.calls).toHaveLength(0);
    expect(await (await t.list(CLONE)).json()).toEqual({ sessions: [] });
  });

  it('starts a session when the balance is one base unit below the amount due', async () => {
    const t = setup({ invoice: { balance: 84_999_999n } });
    expect((await t.post(CLONE)).status).toBe(201);
  });

  // SPEC-QUESTION 1
  it('is 409 already paid for a 100% discount invoice with a zero balance (0 >= 0)', async () => {
    const t = setup({ invoice: { tiers: [{ cutoff: T + 5000n, discountBps: 10_000 }] } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already paid', balance: '0', due: '0' });
  });

  it('checks in order: status before token, token before already paid, and 404 before status', async () => {
    const fundedUsdc = setup({ invoice: { status: 1, token: USDC } });
    const res = await fundedUsdc.post(CLONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'Funded' });
    const richUsdc = setup({ invoice: { token: USDC, balance: 10n ** 12n } });
    expect((await richUsdc.post(CLONE)).status).toBe(422);
    const fundedRich = setup({ invoice: { status: 1, balance: 10n ** 12n } });
    expect(await (await fundedRich.post(CLONE)).json()).toMatchObject({ status: 'Funded' });
    const notClone = setup();
    expect((await notClone.post(NOT_CLONE)).status).toBe(404);
  });

  it('is 201 with the quote, the Link settings and a session expiring at the block timestamp + 600', async () => {
    const t = setup();
    const res = await t.post(CLONE);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      linkToken: 'lt_test_token',
      clientId: MESH_CLIENT_ID,
      linkEnvironment: 'sbx',
      amount: '90000000', // 10% (the 15% tier ends inside the window)
      displayAmount: '90',
      symbol: 'PYUSD',
      discountBps: 1000,
      expiresAt: Number(T) + 600,
    });
  });

  it('mints a token and then creates the session, with the session request as specified', async () => {
    const t = setup();
    const body = (await (await t.post(CLONE)).json()) as { id: string };
    expect(t.fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/oauth2/token', '/v2/sessions']);
    const mint = t.fetch.mints[0];
    expect(mint.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${MESH_CLIENT_ID}:${MESH_CLIENT_SECRET}`).toString('base64')}`);
    const [call] = t.fetch.sessions;
    expect(call.url).toBe(`${MESH_BASE_URL}/v2/sessions`);
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer at_1');
    expect(call.headers.get('idempotency-key')).toBe(`mesh-session-${body.id}`);
    expect(JSON.parse(call.body!)).toEqual({
      userId: `buyer-${body.id}`,
      transferOptions: {
        type: 'TRANSFER_TYPE_PAYMENT',
        clientTransactionId: `${CLONE.toLowerCase()}-${body.id}`,
        toAddresses: [{ networkCaip2: NETWORK_CAIP2, symbol: 'PYUSD', address: getAddress(CLONE), amount: '90' }],
      },
    });
  });

  it('accepts the address in any case', async () => {
    const t = setup();
    const res = await t.post(getAddress(CLONE));
    expect(res.status).toBe(201);
    expect(JSON.parse(t.fetch.sessions[0].body!).transferOptions.toAddresses[0].address).toBe(getAddress(CLONE));
  });

  it('quotes over a 900 s window: a tier ending exactly at t + 900 counts, at t + 901 does not', async () => {
    const at900 = setup({ invoice: { tiers: [{ cutoff: T + 900n, discountBps: 1500 }] } });
    expect(await (await at900.post(CLONE)).json()).toMatchObject({ discountBps: 0, amount: '100000000', displayAmount: '100' });
    const at901 = setup({ invoice: { tiers: [{ cutoff: T + 901n, discountBps: 1500 }] } });
    expect(await (await at901.post(CLONE)).json()).toMatchObject({ discountBps: 1500, amount: '85000000', displayAmount: '85' });
  });

  it("uses the token's decimals() for the display amount and the amount sent to Mesh", async () => {
    const t = setup({ invoice: { principal: 10_000_000_000n } });
    t.world.decimals[PYUSD.toLowerCase()] = 8;
    const body = await (await t.post(CLONE)).json();
    expect(body).toMatchObject({ amount: '9000000000', displayAmount: '90' });
    expect(JSON.parse(t.fetch.sessions[0].body!).transferOptions.toAddresses[0].amount).toBe('90');
  });

  it('floors the discount and sends the amount as an exact decimal string', async () => {
    const t = setup({ invoice: { principal: 333n, tiers: [{ cutoff: T + 5000n, discountBps: 1500 }] } });
    expect(await (await t.post(CLONE)).json()).toMatchObject({ amount: '284', displayAmount: '0.000284' });
    expect(JSON.parse(t.fetch.sessions[0].body!).transferOptions.toAddresses[0].amount).toBe('0.000284');
  });

  it('sends an 18-decimal amount exactly, as a string', async () => {
    const t = setup({ invoice: { principal: 123_456_789_012_345_678n, tiers: [{ cutoff: T + 5000n, discountBps: 0 }] } });
    t.world.decimals[PYUSD.toLowerCase()] = 18;
    expect(await (await t.post(CLONE)).json()).toMatchObject({ amount: '123456789012345678', displayAmount: '0.123456789012345678' });
    expect(JSON.parse(t.fetch.sessions[0].body!).transferOptions.toAddresses[0].amount).toBe('0.123456789012345678');
  });

  it('gives each session its own id, transactionId and idempotency key, and reuses one access token', async () => {
    const t = setup();
    const a = (await (await t.post(CLONE)).json()) as { id: string };
    const b = (await (await t.post(CLONE)).json()) as { id: string };
    expect(a.id).not.toBe(b.id);
    const ids = t.fetch.sessions.map((c) => JSON.parse(c.body!).transferOptions.clientTransactionId);
    expect(new Set(ids).size).toBe(2);
    expect(t.fetch.sessions.map((c) => c.headers.get('idempotency-key'))).toEqual([`mesh-session-${a.id}`, `mesh-session-${b.id}`]);
    expect(t.fetch.mints).toHaveLength(1);
  });

  it('is 502 with status and code when Mesh rejects the session, and records no session', async () => {
    const t = setup({
      mesh: { onSession: () => json({ error: { code: 'invalid_request', message: 'bad', requestId: 'r1' } }, 400) },
    });
    const res = await t.post(CLONE);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await (await t.list(CLONE)).json()).toEqual({ sessions: [] });
    expect(t.sessions.forInvoice(CLONE)).toEqual([]);
  });

  it('is 502 when the token cannot be minted, without a session call', async () => {
    const t = setup({ mesh: { onToken: () => json({ error: 'invalid_client' }, 401) } });
    const res = await t.post(CLONE);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 401 });
    expect(t.fetch.sessions).toHaveLength(0);
    expect(t.sessions.forInvoice(CLONE)).toEqual([]);
  });

  it('is 502 when Mesh is unreachable, or answers 2xx without a token', async () => {
    const down = setup({
      mesh: {
        onSession: () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    const res = await down.post(CLONE);
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty('status');
    expect(down.sessions.forInvoice(CLONE)).toEqual([]);

    const empty = setup({ mesh: { onSession: () => json({}) } });
    expect((await empty.post(CLONE)).status).toBe(502);
    expect(empty.sessions.forInvoice(CLONE)).toEqual([]);
  });

  it('can start a new session after a 502, and re-mints the token after a 401 from the session call', async () => {
    const t = setup({ mesh: { onSession: (_c, n) => (n === 1 ? json({ error: { code: 'unauthorized' } }, 401) : undefined!) } });
    const failed = await t.post(CLONE);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ status: 401, code: 'unauthorized' });
    const res = await t.post(CLONE);
    expect(res.status).toBe(201);
    expect(t.fetch.mints).toHaveLength(2);
    expect(t.fetch.sessions[1].headers.get('authorization')).toBe('Bearer at_2');
    expect(t.sessions.forInvoice(CLONE)).toHaveLength(1);
  });
});

describe('GET /invoices/:address/mesh-session/:id', () => {
  it('returns the session view', async () => {
    const t = setup();
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    const res = await t.get(CLONE, id);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view).toEqual({
      id,
      invoice: getAddress(CLONE),
      state: 'awaiting-transfer',
      amount: '90000000',
      discountBps: 1000,
      expiresAt: Number(T) + 600,
    });
    expect(view).not.toHaveProperty('transactionId');
  });

  it('accepts the invoice address in any case', async () => {
    const t = setup();
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    expect((await t.get(getAddress(CLONE), id)).status).toBe(200);
  });

  it('is 404 for an unknown id', async () => {
    const t = setup();
    expect((await t.get(CLONE, 'ffffffffffffffff')).status).toBe(404);
  });

  it("is 404 for another invoice's session id", async () => {
    const t = setup({ invoices: { [CLONE]: {}, [CLONE_B]: {} } });
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    expect((await t.get(CLONE, id)).status).toBe(200);
    expect((await t.get(CLONE_B, id)).status).toBe(404);
  });

  it('is 400 for an invalid address', async () => {
    const t = setup();
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    expect((await t.get('0x123', id)).status).toBe(400);
  });

  it('reflects the state after a webhook', async () => {
    const t = setup(); // start the session first: with a funded clone the route would answer "already paid"
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    t.world.invoice(CLONE).balance = 90_000_000n; // the transfer lands
    const event = t.event({ sessionId: id });
    await t.processEvent(event);
    const view = (await (await t.get(CLONE, id)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ state: 'settled', transferTx: txHashOf(event), settleTx: t.settle.state.hashes[0] });
    expect(view.payer).toEqual({ provider: 'metamask', sourceAddress: '0x00000000000000000000000000000000000000c1' });
  });

  it('shows a failed session with its reason', async () => {
    const t = setup();
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    await t.processEvent(t.event({ sessionId: id, status: 'failed', transfer: { error_code: 'user_cancelled' } }));
    expect(await (await t.get(CLONE, id)).json()).toMatchObject({ state: 'failed', reason: 'user_cancelled' });
  });
});

describe('GET /invoices/:address/mesh-sessions', () => {
  it('lists the invoice sessions newest first', async () => {
    const t = setup();
    const a = (await (await t.post(CLONE)).json()) as { id: string };
    const b = (await (await t.post(CLONE)).json()) as { id: string };
    const c = (await (await t.post(CLONE)).json()) as { id: string };
    const res = await t.list(CLONE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string; invoice: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    expect(body.sessions[0].invoice).toBe(getAddress(CLONE));
    expect(body.sessions[0]).toMatchObject({ state: 'awaiting-transfer', amount: '90000000' });
  });

  it('only lists the requested invoice', async () => {
    const t = setup({ invoices: { [CLONE]: {}, [CLONE_B]: {} } });
    const a = (await (await t.post(CLONE)).json()) as { id: string };
    await t.post(CLONE_B);
    const body = (await (await t.list(CLONE)).json()) as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual([a.id]);
  });

  it('is an empty list for an invoice without sessions, with no chain reads', async () => {
    const t = setup();
    const res = await t.list(NOT_CLONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
    expect(t.world.log).toEqual([]);
  });

  it('is 400 for an invalid address', async () => {
    expect((await setup().list('0x123')).status).toBe(400);
  });
});

describe('POST /webhooks/mesh', () => {
  const body = () => JSON.stringify(webhookEvent());

  it('is 200 { ok: true } for a valid timestamped HMAC over the raw body', async () => {
    const t = setup();
    const res = await t.webhook(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('is 401 when the body was re-serialized after signing', async () => {
    const t = setup();
    const raw = body();
    const ts = String(nowSeconds());
    const reserialized = JSON.stringify(JSON.parse(raw), null, 2);
    expect((await t.webhook(reserialized, { timestamp: ts, signature: sign(raw, ts) })).status).toBe(401);
    expect((await t.webhook(`${raw} `, { timestamp: ts, signature: sign(raw, ts) })).status).toBe(401);
  });

  it('is 401 for a missing, empty, wrong or malformed signature header', async () => {
    const t = setup();
    const raw = body();
    const ts = String(nowSeconds());
    expect((await t.webhook(raw, { signature: null })).status).toBe(401);
    expect((await t.webhook(raw, { signature: '' })).status).toBe(401);
    expect((await t.webhook(raw, { signature: sign(raw, ts, 'other-secret') })).status).toBe(401);
    expect((await t.webhook(raw, { signature: 'sha256=abc' })).status).toBe(401);
    expect((await t.webhook(raw, { signature: sign(raw, ts).slice('sha256='.length) })).status).toBe(401); // no prefix
    expect((await t.webhook(raw, { signature: sign(raw, ts).toUpperCase() })).status).toBe(401);
  });

  it('is 401 for a missing, empty or non-numeric timestamp header', async () => {
    const t = setup();
    const raw = body();
    expect((await t.webhook(raw, { timestamp: null })).status).toBe(401);
    expect((await t.webhook(raw, { timestamp: '' })).status).toBe(401);
    expect((await t.webhook(raw, { timestamp: 'yesterday' })).status).toBe(401);
  });

  it('is 401 for a correctly signed but stale or future timestamp, 200 within the tolerance', async () => {
    const t = setup();
    const raw = body();
    const at = (offset: number) => t.webhook(raw, { timestamp: String(nowSeconds() + offset) });
    expect((await at(-400)).status).toBe(401);
    expect((await at(400)).status).toBe(401);
    expect((await at(-290)).status).toBe(200);
    expect((await at(290)).status).toBe(200);
  });

  it('is 401 for the old scheme: a Base64 digest of the body alone', async () => {
    const t = setup();
    const raw = body();
    const legacy = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('base64');
    expect((await t.webhook(raw, { signature: legacy })).status).toBe(401);
  });

  it('does not process an unauthenticated event', async () => {
    const t = setup({ invoice: { balance: 90_000_000n } });
    t.sessions.create({
      id: SESSION_ID,
      invoice: CLONE,
      transactionId: txId(CLONE),
      amount: 90_000_000n,
      discountBps: 1000,
      symbol: 'PYUSD',
      expiresAt: 0n,
    });
    await t.webhook(body(), { signature: 'sha256=forged' });
    await t.webhook(body(), { timestamp: String(nowSeconds() - 1000) });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.settle.state.calls).toHaveLength(0);
    expect(t.sessions.get(SESSION_ID)!.state).toBe('awaiting-transfer');
  });

  it('verifies the signature over UTF-8 bytes', async () => {
    const t = setup();
    const raw = JSON.stringify(webhookEvent({ src: { venue: 'café ✓' } }));
    expect((await t.webhook(raw)).status).toBe(200);
  });

  it('is 400 for a signed body that is not JSON', async () => {
    const t = setup();
    for (const raw of ['not json', '', '{"event_id":']) expect((await t.webhook(raw)).status).toBe(400);
  });

  it('is 400 for signed JSON that is not an object, arrays included', async () => {
    const t = setup();
    for (const raw of ['null', '42', '"text"', 'true', '[]', '[{"version":"1"}]']) expect((await t.webhook(raw)).status).toBe(400);
  });

  it('is 401 before 400: an unsigned non-JSON body is 401', async () => {
    expect((await setup().webhook('not json', { signature: null })).status).toBe(401);
  });

  it.each([
    ['an empty object', '{}'],
    ['version 2', JSON.stringify(webhookEvent({ envelope: { version: '2' } }))],
    ['a non-transfer type', JSON.stringify(webhookEvent({ type: 'session.created' }))],
    ['no data.transfer', JSON.stringify({ version: '1', event_id: 'x', type: 'transfer.completed', data: {} })],
  ])('is 200 for a signed event that is ignored: %s', async (_name, raw) => {
    const t = setup();
    expect((await t.webhook(raw)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.settle.state.calls).toHaveLength(0);
  });

  it('returns 200 before processing finishes, then processes the event', async () => {
    const gate = deferred();
    const t = setup({ invoice: { balance: 90_000_000n }, settle: { gate: gate.promise } });
    t.sessions.create({
      id: SESSION_ID,
      invoice: CLONE,
      transactionId: txId(CLONE),
      amount: 90_000_000n,
      discountBps: 1000,
      symbol: 'PYUSD',
      expiresAt: 0n,
    });
    const res = await t.webhook(JSON.stringify(t.event())); // would hang if the route awaited the gated settle
    expect(res.status).toBe(200);
    expect(t.sessions.get(SESSION_ID)!.state).not.toBe('settled');
    await waitFor(() => t.settle.state.calls.length === 1);
    expect(t.settle.state.calls).toHaveLength(1);
    gate.resolve();
    await waitFor(() => t.sessions.get(SESSION_ID)!.state === 'settled');
    expect(t.sessions.get(SESSION_ID)!.state).toBe('settled');
  });

  it('settles end to end from a session started through the API, and dedups a retried delivery', async () => {
    const t = setup(); // the session is started while the clone is still empty
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    t.world.invoice(CLONE).balance = 90_000_000n; // the transfer lands
    const clientTransactionId = JSON.parse(t.fetch.sessions[0].body!).transferOptions.clientTransactionId;
    const raw = JSON.stringify(t.event({ transfer: { client_transaction_id: clientTransactionId } }));
    expect((await t.webhook(raw)).status).toBe(200);
    expect((await t.webhook(raw)).status).toBe(200);
    await waitFor(() => t.sessions.get(id)?.state === 'settled');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.sessions.get(id)!.state).toBe('settled');
    expect(t.settle.state.calls).toHaveLength(1);
    expect(await (await t.get(CLONE, id)).json()).toMatchObject({ state: 'settled' });
  });

  it('the returned processEvent shares the app session store', async () => {
    const t = setup({ invoice: { balance: 1n } });
    const { id } = (await (await t.post(CLONE)).json()) as { id: string };
    await t.processEvent(t.event({ sessionId: id }));
    expect(t.sessions.get(id)).toMatchObject({ state: 'needs-attention', reason: 'insufficient balance: 1 < 85000000' });
  });
});
