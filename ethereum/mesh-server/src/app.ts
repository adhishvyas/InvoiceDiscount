// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import type { Hono } from 'hono';
import type { Address, Client, Hash } from 'viem';
import type { MeshApiConfig } from './mesh';
import type { SessionStore } from './sessions';
import type { MeshWebhookEvent } from './webhook';

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
  throw new Error('unimplemented');
}
