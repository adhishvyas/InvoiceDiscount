import { Challenge, Receipt } from 'mppx';
import type { Address, Hash } from 'viem';

/** The 402 step of the MPP exchange panel (MPP spec §5.2). */
export interface ChallengeView {
  status: number;
  /** The raw `WWW-Authenticate` header. */
  header: string;
  method: string;
  intent: string;
  /** Token base units. */
  amount: bigint;
  currency: Address;
  recipient: Address;
  /** ISO 8601. */
  expires: string | undefined;
  description: string | undefined;
}

/** The Receipt step: the raw `Payment-Receipt` header, decoded. */
export interface ReceiptView {
  header: string;
  method: string;
  /** The transfer's tx hash. */
  reference: Hash;
  status: string;
  timestamp: string;
}

/** The pay endpoint's JSON body (MPP spec §4.3 step 7). */
export interface PayResult {
  invoice: Address;
  transferTx: Hash;
  /** Token base units, as a decimal string. */
  amount: string;
  discountBps: number;
  settleTx: Hash | null;
  settled: boolean;
  settleError?: string;
}

/** Decode the server's 402 with `mppx`'s own parser. Throws if it carries no Payment Challenge. */
export function challengeView(response: Response): ChallengeView {
  const challenge = Challenge.fromResponse(response);
  const request = challenge.request as { amount: string; currency: Address; recipient: Address };
  return {
    status: response.status,
    header: response.headers.get('WWW-Authenticate') ?? '',
    method: challenge.method,
    intent: challenge.intent,
    amount: BigInt(request.amount),
    currency: request.currency,
    recipient: request.recipient,
    expires: challenge.expires,
    description: challenge.description,
  };
}

/** Decode a `Payment-Receipt` header. */
export function receiptView(header: string): ReceiptView {
  const receipt = Receipt.deserialize(header);
  return {
    header,
    method: receipt.method,
    reference: receipt.reference as Hash,
    status: receipt.status,
    timestamp: receipt.timestamp,
  };
}
