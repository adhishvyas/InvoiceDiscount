import type { Context } from 'hono';
import { Challenge, Credential, PaymentRequest, Receipt } from 'mppx';
import { Expires, Mppx, tempo } from 'mppx/server';
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  hexToString,
  isAddress,
  type Account,
  type Address,
  type Client,
  type Hash,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem';
import { tempoModerato } from 'viem/chains';
import { getBlock, readContract, simulateContract, waitForTransactionReceipt, writeContract } from 'viem/actions';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { isClone, readInvoice, Status, STATUS_NAME } from './invoice';
import { quoteAmount, quoteBps } from './quote';

/** TIP-20 tokens on Tempo have 6 decimals; `mppx` takes amounts in display units. */
const DECIMALS = 6;

/** Placeholder so `tempo.charge` makes one offer; each request overrides it with the invoice's token (MPP spec §4.1). */
const ALPHA_USD = '0x20c0000000000000000000000000000000000001';

export interface PayConfig {
  client: Client;
  /** Sends `settleDirect()`; absent in tests, which stop at the 402. */
  settler?: WalletClient<Transport, typeof tempoModerato, Account>;
  factory: Address;
  /** `MPP_SECRET_KEY`: binds Challenges to this server. */
  secretKey: string;
}

/** Copied from `frontend/src/lib/ref.ts`: bytes32 back to the reference string, without the zero padding. */
const decodeRef = (b: Hex): string => hexToString(b, { size: 32 });

/** The echoed Challenge, if the request carries a Credential for a Challenge this server issued. */
function issuedChallenge(request: Request, secretKey: string) {
  try {
    const { challenge } = Credential.fromRequest(request);
    return Challenge.verify(challenge, { secretKey }) ? challenge : undefined;
  } catch {
    return undefined;
  }
}

/** Server metadata of a Challenge read off the wire, where it arrives serialized as `opaque`. */
const boundMeta = (challenge: Challenge.Challenge): Record<string, unknown> =>
  challenge.opaque ? PaymentRequest.deserialize(challenge.opaque) : {};

/** The custom error name from a revert, or the short message for anything else. */
function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
    return error.shortMessage;
  }
  return String(error);
}

/** `POST /invoices/:address/pay` (MPP spec §4.3). */
export function payHandler(config: PayConfig) {
  const { client, settler, secretKey } = config;
  const mppx = Mppx.create({ methods: [tempo.charge({ testnet: true, currency: ALPHA_USD })], secretKey });

  return async (c: Context) => {
    const param = c.req.param('address');
    if (!param || !isAddress(param)) return c.json({ error: 'invalid address' }, 400);
    const address = getAddress(param);
    if (!(await isClone(client, config.factory, address))) return c.json({ error: 'not an invoice of this factory' }, 404);

    const invoice = await readInvoice(client, address);
    if (invoice.status !== Status.Active) return c.json({ error: 'invoice is not Active', status: STATUS_NAME[invoice.status] }, 409);

    // Retry: reuse the echoed quote, since mppx pins the amount to the Challenge. `amount` and `meta` are
    // covered by the Challenge HMAC; `description` is not, so it is rebuilt from the bound `discountBps`.
    let amount: bigint;
    let bps: number;
    const echoed = issuedChallenge(c.req.raw, secretKey);
    if (echoed) {
      amount = BigInt(echoed.request.amount as string);
      bps = Number(boundMeta(echoed).discountBps ?? 0);
    } else {
      const { timestamp } = await getBlock(client);
      bps = await quoteBps(
        timestamp,
        invoice.tiers.map((tier) => tier.cutoff),
        (ts) => readContract(client, { address, abi: invoiceEscrowAbi, functionName: 'activeDiscount', args: [ts] }),
      );
      amount = quoteAmount(invoice.principal, bps);
    }

    const result = await mppx.charge({
      amount: formatUnits(amount, DECIMALS),
      currency: invoice.token,
      recipient: address,
      expires: Expires.minutes(2),
      description: `Invoice ${decodeRef(invoice.invoiceRef)}: ${bps / 100}% early-payment discount`,
      meta: { discountBps: String(bps) },
    })(c.req.raw);
    if (result.status === 402) return result.challenge;

    const stamped = result.withReceipt(new Response(null));
    const transferTx = Receipt.fromResponse(stamped).reference as Hash;

    let settleTx: Hash | null = null;
    let settled = false;
    let settleError: string | undefined;
    try {
      if (!settler) throw new Error('no settler configured');
      const { request } = await simulateContract(settler, {
        address,
        abi: invoiceEscrowAbi,
        functionName: 'settleDirect',
        account: settler.account,
      });
      settleTx = await writeContract(settler, request);
      const receipt = await waitForTransactionReceipt(client, { hash: settleTx });
      settled = receipt.status === 'success';
      if (!settled) settleError = 'reverted';
    } catch (error) {
      settleError = revertReason(error);
    }

    const headers = new Headers(stamped.headers);
    headers.set('Content-Type', 'application/json');
    const body = { invoice: address, transferTx, amount: amount.toString(), discountBps: bps, settleTx, settled, settleError };
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
}
