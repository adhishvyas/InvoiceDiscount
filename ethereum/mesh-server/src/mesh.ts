// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import type { Address } from 'viem';

export interface MeshApiConfig {
  /** e.g. `https://sandbox-integration-api.meshconnect.com` (no trailing slash). */
  baseUrl: string;
  clientId: string;
  apiKey: string;
  /** Defaults to the global `fetch`; tests pass a fake. */
  fetch?: typeof fetch;
}

export interface LinkTokenParams {
  /** The invoice clone: the one destination. */
  invoice: Address;
  /** Mesh's symbol for the invoice token, e.g. `PYUSD`. */
  symbol: string;
  /** From `toMeshAmount`. */
  amount: number;
  networkId: string;
  transactionId: string;
  userId: string;
}

export interface LinkTokenRequestBody {
  userId: string;
  restrictMultipleAccounts: true;
  transferOptions: {
    transferType: 'payment';
    transactionId: string;
    isInclusiveFeeEnabled: false;
    generatePayLink: false;
    toAddresses: [{ networkId: string; symbol: string; address: Address; amount: number }];
  };
}

/** A failed Link Token request. `status` is Mesh's HTTP status, or undefined if no usable response arrived. */
export class MeshApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MeshApiError';
    this.status = status;
  }
}

/**
 * The `POST /api/v1/linktoken` body for a fixed payment of `amount` `symbol` to `invoice` (Mesh spec §4.3 step 6):
 * `transferType: "payment"`, `isInclusiveFeeEnabled: false`, `generatePayLink: false`,
 * `restrictMultipleAccounts: true`, and exactly one `toAddresses` entry. `address` is passed through as given.
 */
export function linkTokenRequestBody(p: LinkTokenParams): LinkTokenRequestBody {
  return {
    userId: p.userId,
    restrictMultipleAccounts: true,
    transferOptions: {
      transferType: 'payment',
      transactionId: p.transactionId,
      isInclusiveFeeEnabled: false,
      generatePayLink: false,
      toAddresses: [{ networkId: p.networkId, symbol: p.symbol, address: p.invoice, amount: p.amount }],
    },
  };
}

/**
 * `POST ${baseUrl}/api/v1/linktoken` with headers `X-Client-Id`, `X-Client-Secret` and
 * `Content-Type: application/json`, and `linkTokenRequestBody(p)` as the JSON body. Returns `content.linkToken`
 * from the response (§6.1 fallback shape).
 * Throws `MeshApiError`:
 * - on a non-2xx response, with that status;
 * - on a 2xx response whose body isn't JSON or has no non-empty string `content.linkToken`, with that 2xx status;
 * - when `fetch` itself rejects (network error), with `status` undefined.
 */
export async function requestLinkToken(config: MeshApiConfig, p: LinkTokenParams): Promise<string> {
  const doFetch = config.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${config.baseUrl}/api/v1/linktoken`, {
      method: 'POST',
      headers: { 'X-Client-Id': config.clientId, 'X-Client-Secret': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(linkTokenRequestBody(p)),
    });
  } catch (error) {
    throw new MeshApiError(`Mesh request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new MeshApiError(`Mesh returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, res.status);
  let linkToken: unknown;
  try {
    linkToken = ((await res.json()) as { content?: { linkToken?: unknown } } | null)?.content?.linkToken;
  } catch {
    throw new MeshApiError('Mesh response is not JSON', res.status);
  }
  if (typeof linkToken !== 'string' || linkToken === '') throw new MeshApiError('Mesh response has no content.linkToken', res.status);
  return linkToken;
}
