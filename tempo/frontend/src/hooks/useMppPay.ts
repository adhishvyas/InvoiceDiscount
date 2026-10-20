import { Credential } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { useCallback, useState } from 'react';
import type { Address, Hash } from 'viem';
import { useAccount } from 'wagmi';
import { MPP_SERVER_URL } from '../config';
import { challengeView, receiptView, type ChallengeView, type PayResult, type ReceiptView } from '../lib/mpp';

/** The Credential step of the MPP exchange panel. */
export interface CredentialView {
  method: string;
  intent: string;
  /** `hash` in push mode: the wallet broadcast the transfer itself. */
  type: string;
  /** The transfer's tx hash, in push mode. */
  hash: Hash | undefined;
}

/** Everything the MPP exchange panel shows, filled in as the exchange runs (MPP spec §5.2). */
export interface MppExchange {
  challenge?: ChallengeView;
  credential?: CredentialView;
  receipt?: ReceiptView;
  result?: PayResult;
}

export type MppState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'quoted' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/** The Accounts SDK provider's hook into `mppx` (it bundles an older `mppx`, so only `getClient` is taken). */
type GetClient = NonNullable<NonNullable<Parameters<typeof tempo.charge>[0]>['getClient']>;
type AccountsProvider = { getMppxParameters(): { getClient: GetClient } };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

/** The server's message from a 4xx/5xx: `{ error }` from our routes, `{ detail }` from an mppx problem. */
async function serverError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; status?: string; detail?: string; title?: string };
    const message = body.error ?? body.detail ?? body.title ?? res.statusText;
    return body.status ? `${message} (${body.status})` : message;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/**
 * Pay an invoice now through the MPP server, in two steps the UI calls separately:
 * `quote()` asks for the 402 to show the user, `pay()` runs the paid request once they confirm.
 */
export function useMppPay(invoice: Address) {
  const { connector } = useAccount();
  const [state, setState] = useState<MppState>({ status: 'idle' });
  const [exchange, setExchange] = useState<MppExchange>({});
  const url = `${MPP_SERVER_URL}/invoices/${invoice}/pay`;

  const quote = useCallback(async (): Promise<ChallengeView | undefined> => {
    setState({ status: 'pending' });
    setExchange({});
    try {
      const res = await fetch(url, { method: 'POST' });
      if (res.status !== 402) throw new Error(await serverError(res));
      const challenge = challengeView(res);
      setExchange({ challenge });
      setState({ status: 'quoted' });
      return challenge;
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e) });
      return undefined;
    }
  }, [url]);

  /** `confirmed` is the quote the user agreed to; the wallet refuses a Challenge for more than that. */
  const pay = useCallback(
    async (token: Address, confirmed: bigint): Promise<PayResult | undefined> => {
      setState({ status: 'pending' });
      try {
        if (!connector) throw new Error('Connect Tempo Wallet first');
        const provider = (await connector.getProvider()) as AccountsProvider;
        const { getClient } = provider.getMppxParameters();
        const mppx = Mppx.create({
          polyfill: false,
          methods: [
            tempo.charge({ getClient, expectedRecipients: [invoice], currencies: [token], maxAtomicAmount: confirmed.toString() }),
          ],
        });
        // The paid request gets its own 402 first; show that Challenge, since it is the one paid.
        mppx.onChallengeReceived(({ response }) => {
          if (response) setExchange((x) => ({ ...x, challenge: challengeView(response) }));
          return undefined;
        });
        mppx.onCredentialCreated(({ credential }) => {
          const { challenge, payload } = Credential.deserialize(credential);
          const { type, hash } = payload as { type: string; hash?: Hash };
          setExchange((x) => ({ ...x, credential: { method: challenge.method, intent: challenge.intent, type, hash } }));
        });

        const res = await mppx.fetch(url, { method: 'POST' });
        if (!res.ok) throw new Error(await serverError(res));
        const header = res.headers.get('Payment-Receipt');
        const result = (await res.json()) as PayResult;
        setExchange((x) => ({ ...x, receipt: header ? receiptView(header) : undefined, result }));
        setState({ status: 'success' });
        return result;
      } catch (e) {
        setState({ status: 'error', message: errorMessage(e) });
        return undefined;
      }
    },
    [connector, invoice, url],
  );

  const reset = useCallback(() => {
    setState({ status: 'idle' });
    setExchange({});
  }, []);

  return { state, exchange, quote, pay, reset };
}
