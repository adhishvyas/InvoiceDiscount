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
  return {
    userId: p.userId,
    transferOptions: {
      type: 'TRANSFER_TYPE_PAYMENT',
      clientTransactionId: p.clientTransactionId,
      toAddresses: [{ networkCaip2: p.networkCaip2, symbol: p.symbol, address: p.invoice, amount: p.amount }],
    },
  };
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
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  let cached: { token: string; refreshAt: number } | undefined;
  let minting: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const res = await send(`${config.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', audience: new URL(config.baseUrl).host, scope: MESH_SCOPE }).toString(),
    });
    const body = (await jsonOf(res)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof body?.access_token !== 'string' || body.access_token === '' || typeof body.expires_in !== 'number') {
      throw new MeshApiError('Mesh token response has no access_token/expires_in', res.status);
    }
    cached = { token: body.access_token, refreshAt: now() + (body.expires_in - TOKEN_REFRESH_MARGIN_SECONDS) * 1000 };
    return body.access_token;
  }

  async function accessToken(): Promise<string> {
    if (cached && now() < cached.refreshAt) return cached.token;
    minting ??= mint().finally(() => (minting = undefined));
    return minting;
  }

  /** `fetch`, with a network error or a non-2xx turned into `MeshApiError`. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (error) {
      throw new MeshApiError(`Mesh request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let envelope: { error?: { code?: unknown; message?: unknown } } | undefined;
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = undefined;
      }
      const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined;
      const message = typeof envelope?.error?.message === 'string' ? envelope.error.message : text.slice(0, 200);
      throw new MeshApiError(`Mesh returned ${res.status}${message ? `: ${message}` : ''}`, res.status, code);
    }
    return res;
  }

  return {
    accessToken,
    async createPaymentSession(p) {
      const token = await accessToken();
      let res: Response;
      try {
        res = await send(`${config.baseUrl}/v2/sessions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': p.idempotencyKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(paymentSessionBody(p)),
        });
      } catch (error) {
        if (error instanceof MeshApiError && error.status === 401) cached = undefined;
        throw error;
      }
      const body = (await jsonOf(res)) as { token?: unknown; sessionId?: unknown; expiresAt?: unknown } | undefined;
      if (typeof body?.token !== 'string' || body.token === '') throw new MeshApiError('Mesh session response has no token', res.status);
      return { token: body.token, sessionId: String(body.sessionId ?? ''), expiresAt: String(body.expiresAt ?? '') };
    },
  };
}

/** The response body as JSON, or a `MeshApiError` with the (2xx) status if it isn't JSON. */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new MeshApiError('Mesh response is not JSON', res.status);
  }
}
