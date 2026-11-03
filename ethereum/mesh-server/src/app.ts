// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { erc20Abi, formatUnits, getAddress, isAddress, type Address, type Client, type Hash } from 'viem';
import { getBlock, readContract } from 'viem/actions';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { encodeTransactionId, newSessionId } from './ids';
import { isClone, readInvoice, Status, STATUS_NAME, tokenBalance } from './invoice';
import { MeshApiError, requestLinkToken, type MeshApiConfig } from './mesh';
import { quoteAmount, quoteBps, QUOTE_WINDOW, toMeshAmount } from './quote';
import { SessionStore, sessionView } from './sessions';
import { verifyMeshSignature } from './signature';
import { createEventProcessor, type MeshWebhookEvent } from './webhook';

/** The Link Token's life (Mesh docs: 10 minutes). */
const LINK_TOKEN_LIFE = 600n;

export interface AppConfig {
  /** CORS origin, matched exactly. */
  allowedOrigin: string;
  client: Client;
  factory: Address;
  meshApi: MeshApiConfig;
  /** Mesh-supported token address (checksummed) → Mesh's symbol. */
  meshTokens: Record<Address, string>;
  /** Mesh's `networkId` for Sepolia. */
  networkId: string;
  /** The `Chain` string a Sepolia webhook carries. */
  chainName: string;
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
 *    `decimals()` is read from the token; `displayAmount = formatUnits(amount, decimals)`.
 * 6. `requestLinkToken` with `invoice` = the checksummed clone, `symbol` = `meshTokens[token]`, `amount` =
 *    `toMeshAmount(amount, decimals)`, `networkId`, `transactionId = encodeTransactionId(invoice, id)` and
 *    `userId = "buyer-" + id`, for a fresh `id = newSessionId()`. A `MeshApiError` → `502 { error, status? }`;
 *    no session is recorded.
 * 7. Record the session (`awaiting-transfer`, `expiresAt = t + 600`) →
 *    `201 { id, linkToken, amount, displayAmount, symbol, discountBps, expiresAt }` (`amount` a decimal string in base
 *    units, `expiresAt` unix seconds as a number).
 *
 * `GET /invoices/:address/mesh-session/:id` → `200 SessionView`. `400` for an invalid address; `404` for an unknown id
 * or a session of another invoice (addresses compare case-insensitively).
 *
 * `GET /invoices/:address/mesh-sessions` → `200 { sessions: SessionView[] }`, most recent first; `[]` when there are
 * none. `400` for an invalid address. No chain reads.
 *
 * `POST /webhooks/mesh`: the raw body is checked with `verifyMeshSignature` against the `X-Mesh-Signature-256`
 * header before parsing. Missing or bad → `401`. Valid but not a JSON object → `400`. Otherwise `200 { ok: true }`
 * is returned **without awaiting** the processor, which is then run on the parsed event.
 */
export function createApp(config: AppConfig): {
  app: Hono;
  sessions: SessionStore;
  processEvent: (event: MeshWebhookEvent) => Promise<void>;
} {
  const { client } = config;
  const sessions = config.sessions ?? new SessionStore();
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
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    const due = quoteAmount(invoice.principal, bpsNow);
    if (balance >= due) return c.json({ error: 'already paid', balance: balance.toString(), due: due.toString() }, 409);

    const discountBps = await quoteBps(t, invoice.tiers.map((tier) => tier.cutoff), discountAt, QUOTE_WINDOW);
    const amount = quoteAmount(invoice.principal, discountBps);
    const id = newSessionId();
    const transactionId = encodeTransactionId(address, id);
    let linkToken: string;
    try {
      linkToken = await requestLinkToken(config.meshApi, {
        invoice: address,
        symbol,
        amount: toMeshAmount(amount, decimals),
        networkId: config.networkId,
        transactionId,
        userId: `buyer-${id}`,
      });
    } catch (error) {
      if (error instanceof MeshApiError) return c.json({ error: error.message, status: error.status }, 502);
      throw error;
    }

    const expiresAt = t + LINK_TOKEN_LIFE;
    sessions.create({ id, invoice: address, transactionId, amount, discountBps, symbol, expiresAt });
    return c.json(
      { id, linkToken, amount: amount.toString(), displayAmount: formatUnits(amount, decimals), symbol, discountBps, expiresAt: Number(expiresAt) },
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
    if (!verifyMeshSignature(raw, c.req.header('X-Mesh-Signature-256'), config.webhookSecret)) return c.json({ error: 'bad signature' }, 401);
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
