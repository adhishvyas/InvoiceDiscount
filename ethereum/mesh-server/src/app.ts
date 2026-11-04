// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { formatUnits, getAddress, isAddress, type Address, type Client, type Hash } from 'viem';
import { getBlock, readContract } from 'viem/actions';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { encodeTransactionId, newSessionId } from './ids';
import { isClone, readInvoice, Status, STATUS_NAME, tokenBalance, tokenDecimals } from './invoice';
import { createMeshClient, MeshApiError, type MeshApiConfig, type MeshSession } from './mesh';
import { quoteAmount, quoteBps, QUOTE_WINDOW } from './quote';
import { SessionStore, sessionView } from './sessions';
import { verifyMeshSignature } from './signature';
import { createEventProcessor, type MeshWebhookEvent } from './webhook';

/** The quote's life (Mesh spec §4.3 step 7); the Mesh session itself lives about an hour. */
const QUOTE_LIFE = 600n;

/** The Link SDK `environment` the frontend passes to `openLink()`. */
export type LinkEnvironment = 'sbx' | 'prod';

export interface AppConfig {
  /** CORS origin, matched exactly. */
  allowedOrigin: string;
  client: Client;
  factory: Address;
  /** `createApp` builds one `createMeshClient(meshApi)` (one token cache) for the app. */
  meshApi: MeshApiConfig;
  /** Returned to the frontend with each session. */
  linkEnvironment: LinkEnvironment;
  /** Mesh-supported token address (checksummed) → Mesh's symbol. */
  meshTokens: Record<Address, string>;
  /** The target network's CAIP-2 id, e.g. `eip155:11155111`. */
  networkCaip2: string;
  webhookSecret: string;
  /** See `WebhookContext.settle`. */
  settle: (invoice: Address) => Promise<Hash>;
  /** See `WebhookContext.receiptTimeoutMs`. */
  receiptTimeoutMs: number;
  /** Defaults to a new, empty store. */
  sessions?: SessionStore;
}

/**
 * The HTTP app, without a listener, so tests can call `app.request()`. Also returns the session store and the
 * webhook event processor (`createEventProcessor` over the same config and store), so tests can await processing.
 *
 * All JSON. Error bodies are `{ error: string, ...details }`. CORS allows `allowedOrigin` only.
 *
 * `GET /health` → `200 { ok: true }`.
 *
 * `POST /invoices/:address/mesh-session` (Mesh spec §4.3), checks in this order:
 * 1. `:address` not an address → `400`. Not a clone of `factory`'s implementation → `404`.
 * 2. `getInvoice()` status not Active → `409 { error, status: "Funded" | "Paid" | "Cancelled" }`.
 * 3. Invoice token not in `meshTokens` → `422 { error, token }`.
 * 4. With `t` = the latest block's timestamp: clone balance `>=` `quoteAmount(principal, activeDiscount(t))` →
 *    `409 { error: "already paid", balance, due }` (decimal strings).
 * 5. Quote: `discountBps = quoteBps(t, tier cutoffs, activeDiscount, QUOTE_WINDOW)`, `amount = quoteAmount(principal, discountBps)`.
 *    `decimals = tokenDecimals(token)` (18 for an ETH invoice, `token == NATIVE_TOKEN`); `displayAmount = formatUnits(amount, decimals)`.
 *    For an ETH invoice the balance in step 4 is the clone's ETH balance (`tokenBalance`), and `meshTokens` must map
 *    `NATIVE_TOKEN` (e.g. to `ETH`) for step 3 to pass.
 * 6. For a fresh `id = newSessionId()`: `createPaymentSession` with `invoice` = the checksummed clone, `symbol` =
 *    `meshTokens[token]`, `amount` = `displayAmount`, `networkCaip2`, `clientTransactionId = encodeTransactionId(invoice, id)`,
 *    `userId = "buyer-" + id` and `idempotencyKey = "mesh-session-" + id`. A `MeshApiError` (from the token mint or
 *    the session call) → `502 { error, status?, code? }`; no session is recorded.
 * 7. Record the session (`awaiting-transfer`, `transactionId` = the `clientTransactionId`, `expiresAt = t + 600`) →
 *    `201 { id, linkToken, clientId, linkEnvironment, amount, displayAmount, symbol, discountBps, expiresAt }`:
 *    `linkToken` is Mesh's session `token`, `clientId` is `meshApi.clientId`, `amount` a decimal string in base
 *    units, `expiresAt` unix seconds as a number.
 *
 * `GET /invoices/:address/mesh-session/:id` → `200 SessionView`. `400` for an invalid address; `404` for an unknown id
 * or a session of another invoice (addresses compare case-insensitively).
 *
 * `GET /invoices/:address/mesh-sessions` → `200 { sessions: SessionView[] }`, most recent first; `[]` when there are
 * none. `400` for an invalid address. No chain reads.
 *
 * `POST /webhooks/mesh`: the raw body, `X-Mesh-Timestamp` and `X-Mesh-Signature-256` are checked with
 * `verifyMeshSignature` (current time) before parsing. Missing or bad → `401`. Valid but not a JSON object (arrays
 * included) → `400`. Otherwise `200 { ok: true }` is returned **without awaiting** the processor, which is then run
 * on the parsed event (so ignored versions and types are also `200`).
 */
export function createApp(config: AppConfig): {
  app: Hono;
  sessions: SessionStore;
  processEvent: (event: MeshWebhookEvent) => Promise<void>;
} {
  const { client } = config;
  const sessions = config.sessions ?? new SessionStore();
  const mesh = createMeshClient(config.meshApi);
  const processEvent = createEventProcessor({ ...config, sessions });
  const app = new Hono();
  app.use('*', cors({ origin: config.allowedOrigin }));

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/invoices/:address/mesh-session', async (c) => {
    const param = c.req.param('address');
    if (!isAddress(param)) return c.json({ error: 'invalid address' }, 400);
    const address = getAddress(param);
    if (!(await isClone(client, config.factory, address))) return c.json({ error: 'not an invoice of this factory' }, 404);

    const invoice = await readInvoice(client, address);
    if (invoice.status !== Status.Active) return c.json({ error: 'invoice is not Active', status: STATUS_NAME[invoice.status] }, 409);
    const token = getAddress(invoice.token);
    const symbol = config.meshTokens[token];
    if (!symbol) return c.json({ error: 'token not supported by Mesh', token }, 422);

    const { timestamp: t } = await getBlock(client);
    const discountAt = (ts: bigint) => readContract(client, { address, abi: invoiceEscrowAbi, functionName: 'activeDiscount', args: [ts] });
    const [balance, bpsNow, decimals] = await Promise.all([
      tokenBalance(client, token, address),
      discountAt(t),
      tokenDecimals(client, token),
    ]);
    const due = quoteAmount(invoice.principal, bpsNow);
    if (balance >= due) return c.json({ error: 'already paid', balance: balance.toString(), due: due.toString() }, 409);

    const discountBps = await quoteBps(t, invoice.tiers.map((tier) => tier.cutoff), discountAt, QUOTE_WINDOW);
    const amount = quoteAmount(invoice.principal, discountBps);
    const displayAmount = formatUnits(amount, decimals);
    const id = newSessionId();
    const transactionId = encodeTransactionId(address, id);
    let meshSession: MeshSession;
    try {
      meshSession = await mesh.createPaymentSession({
        invoice: address,
        symbol,
        amount: displayAmount,
        networkCaip2: config.networkCaip2,
        clientTransactionId: transactionId,
        userId: `buyer-${id}`,
        idempotencyKey: `mesh-session-${id}`,
      });
    } catch (error) {
      if (error instanceof MeshApiError) return c.json({ error: error.message, status: error.status, code: error.code }, 502);
      throw error;
    }

    const expiresAt = t + QUOTE_LIFE;
    sessions.create({ id, invoice: address, transactionId, amount, discountBps, symbol, expiresAt });
    return c.json(
      {
        id,
        linkToken: meshSession.token,
        clientId: config.meshApi.clientId,
        linkEnvironment: config.linkEnvironment,
        amount: amount.toString(),
        displayAmount,
        symbol,
        discountBps,
        expiresAt: Number(expiresAt),
      },
      201,
    );
  });

  app.get('/invoices/:address/mesh-session/:id', (c) => {
    const param = c.req.param('address');
    if (!isAddress(param)) return c.json({ error: 'invalid address' }, 400);
    const session = sessions.get(c.req.param('id'));
    if (!session || session.invoice.toLowerCase() !== param.toLowerCase()) return c.json({ error: 'unknown session' }, 404);
    return c.json(sessionView(session));
  });

  app.get('/invoices/:address/mesh-sessions', (c) => {
    const param = c.req.param('address');
    if (!isAddress(param)) return c.json({ error: 'invalid address' }, 400);
    return c.json({ sessions: sessions.forInvoice(param).map(sessionView) });
  });

  app.post('/webhooks/mesh', async (c) => {
    const raw = await c.req.text();
    const valid = verifyMeshSignature(raw, c.req.header('X-Mesh-Timestamp'), c.req.header('X-Mesh-Signature-256'), config.webhookSecret);
    if (!valid) return c.json({ error: 'bad signature' }, 401);
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: 'body is not JSON' }, 400);
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return c.json({ error: 'body is not a JSON object' }, 400);
    void processEvent(event as MeshWebhookEvent);
    return c.json({ ok: true });
  });

  return { app, sessions, processEvent };
}
