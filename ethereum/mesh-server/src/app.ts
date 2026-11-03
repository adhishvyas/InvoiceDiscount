// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import type { Hono } from 'hono';
import type { Address, Client, Hash } from 'viem';
import type { MeshApiConfig } from './mesh';
import type { SessionStore } from './sessions';
import type { MeshWebhookEvent } from './webhook';

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
  throw new Error('unimplemented');
}
