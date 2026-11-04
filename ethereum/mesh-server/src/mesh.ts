// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import type { Address } from 'viem';

export interface MeshApiConfig {
  /** e.g. `https://api.sbx.meshpay.com` (no trailing slash). Its host is the OAuth `audience`. */
  baseUrl: string;
  clientId: string;
  /** The client secret (`MESH_API_KEY`). */
  clientSecret: string;
  /** Defaults to the global `fetch`; tests pass a fake. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch, for the token cache. Defaults to `Date.now`; tests pass a fake clock. */
  now?: () => number;
}

/** The scope mesh-server asks for: it only creates sessions. */
export const MESH_SCOPE = 'sessions:edit';

/** A cached token is replaced this many seconds before its `expires_in` runs out. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;

export interface PaymentSessionParams {
  /** The invoice clone: the one destination. */
  invoice: Address;
  /** Mesh's symbol for the invoice token, e.g. `PYUSD`. */
  symbol: string;
  /** The exact token amount, a decimal string in token units (`formatUnits(amount, decimals)`). */
  amount: string;
  /** CAIP-2 network id, e.g. `eip155:11155111`. */
  networkCaip2: string;
  /** Ours, from `encodeTransactionId`. */
  clientTransactionId: string;
  userId: string;
  /** Sent as the `Idempotency-Key` header. */
  idempotencyKey: string;
}

export interface CreateSessionBody {
  userId: string;
  transferOptions: {
    type: 'TRANSFER_TYPE_PAYMENT';
    clientTransactionId: string;
    toAddresses: [{ networkCaip2: string; symbol: string; address: Address; amount: string }];
  };
}

/** What `POST /v2/sessions` returned that mesh-server uses. */
export interface MeshSession {
  /** Single-use exchange code for `openLink()`. */
  token: string;
  sessionId: string;
  /** RFC 3339, as Mesh sent it. */
  expiresAt: string;
}

/**
 * A failed Mesh call. `status` is Mesh's HTTP status, or undefined if no usable response arrived (network error).
 * `code` is Mesh's `error.code` from its error envelope, when the body has one.
 */
export class MeshApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'MeshApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The `POST /v2/sessions` body for a fixed payment of `amount` `symbol` to `invoice` (Mesh spec §4.3 step 6):
 * `transferOptions.type: "TRANSFER_TYPE_PAYMENT"`, `clientTransactionId`, and exactly one `toAddresses` entry
 * `{ networkCaip2, symbol, address: invoice, amount }`. No `amountInFiat`. `address` is passed through as given.
 */
export function paymentSessionBody(p: PaymentSessionParams): CreateSessionBody {
  throw new Error('unimplemented');
}

export interface MeshClient {
  /**
   * A bearer token for `/v2` calls. Minted with `POST ${baseUrl}/oauth2/token`:
   * `Authorization: Basic base64(clientId:clientSecret)`, `Content-Type: application/x-www-form-urlencoded`, body
   * `grant_type=client_credentials&audience=<host of baseUrl>&scope=sessions:edit`. The response's `access_token` is
   * cached and returned until `expires_in - TOKEN_REFRESH_MARGIN_SECONDS` seconds after it was minted (per `now`),
   * then a new one is minted. Concurrent callers while a mint is in flight share that one request. A failed mint
   * isn't cached: the next call tries again.
   * Throws `MeshApiError`: non-2xx (with the status), a 2xx without a non-empty string `access_token` or a numeric
   * `expires_in` (with the 2xx status), or `fetch` rejecting (status undefined).
   */
  accessToken(): Promise<string>;
  /**
   * `POST ${baseUrl}/v2/sessions` with `Authorization: Bearer <accessToken()>`, `Idempotency-Key: <p.idempotencyKey>`,
   * `Content-Type: application/json` and `paymentSessionBody(p)` as the JSON body. Returns `{ token, sessionId, expiresAt }`.
   * On a `401` the cached token is dropped (the next call mints a new one) and the error is thrown; there is no retry.
   * Throws `MeshApiError` as `accessToken()` does, and also for a non-2xx session response (with the status and
   * `error.code` when present) or a 2xx without a non-empty string `token`.
   */
  createPaymentSession(p: PaymentSessionParams): Promise<MeshSession>;
}

/** A Mesh API client with its own token cache (one per process). */
export function createMeshClient(config: MeshApiConfig): MeshClient {
  throw new Error('unimplemented');
}
