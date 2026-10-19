import { isAddress } from 'viem';
import { REF_MAX_BYTES, refByteLength } from './ref';
import { toUnits } from './units';

export const MAX_TIERS = 10;
const UINT128_MAX = (1n << 128n) - 1n;

export interface TierInput {
  /** Unix seconds, or null if not chosen yet. */
  cutoff: number | null;
  /** Percent as typed, e.g. "15" or "12.5" (at most 2 decimals). */
  discountPercent: string;
}

export interface InvoiceFormInput {
  invoiceRef: string;
  amount: string;
  token: string;
  decimals: number;
  /** Unix seconds, or null if not chosen yet. */
  dueDate: number | null;
  tiers: TierInput[];
  /** Empty means "pay the connected wallet". */
  payoutAddress: string;
}

export interface FormErrors {
  invoiceRef?: string;
  amount?: string;
  token?: string;
  dueDate?: string;
  tiers?: string;
  tierRows: Record<number, { cutoff?: string; discount?: string }>;
  payoutAddress?: string;
}

/** "15" or "12.5" to basis points; null if it is not a percent with at most 2 decimals. */
export const percentToBps = (percent: string): number | null => {
  const s = percent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
};

/** Mirrors the contract's initialize checks (spec §3.5) so the form can block a failing transaction. */
export const validateInvoiceForm = (
  input: InvoiceFormInput,
  nowSec: number,
): { valid: boolean; errors: FormErrors } => {
  const errors: FormErrors = { tierRows: {} };

  const refBytes = refByteLength(input.invoiceRef);
  if (refBytes === 0) errors.invoiceRef = 'Enter an invoice reference';
  else if (refBytes > REF_MAX_BYTES) errors.invoiceRef = `Reference is ${refBytes} bytes; the limit is ${REF_MAX_BYTES}`;

  const amount = input.amount.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${input.decimals}})?$`).test(amount)) {
    errors.amount = `Enter an amount with at most ${input.decimals} decimals`;
  } else {
    const units = toUnits(amount, input.decimals);
    if (units === 0n) errors.amount = 'Amount must be greater than zero';
    else if (units > UINT128_MAX) errors.amount = 'Amount is too large';
  }

  if (!isAddress(input.token)) errors.token = 'Choose a token';

  if (input.dueDate === null) errors.dueDate = 'Choose a due date';
  else if (input.dueDate <= nowSec) errors.dueDate = 'Due date must be in the future';

  if (input.tiers.length > MAX_TIERS) errors.tiers = `At most ${MAX_TIERS} discount tiers`;

  let previousCutoff = 0;
  input.tiers.forEach((tier, i) => {
    const row: { cutoff?: string; discount?: string } = {};
    if (tier.cutoff === null) row.cutoff = 'Choose a cutoff date';
    else if (tier.cutoff <= previousCutoff) row.cutoff = 'Cutoffs must be in ascending order';
    else if (input.dueDate !== null && tier.cutoff > input.dueDate) row.cutoff = 'Cutoff cannot be after the due date';
    if (tier.cutoff !== null) previousCutoff = tier.cutoff;

    const bps = percentToBps(tier.discountPercent);
    if (bps === null) row.discount = 'Enter a percent with at most 2 decimals';
    else if (bps > 10_000) row.discount = 'Discount cannot exceed 100%';

    if (row.cutoff || row.discount) errors.tierRows[i] = row;
  });

  const payout = input.payoutAddress.trim();
  if (payout !== '' && !isAddress(payout)) errors.payoutAddress = 'Enter a valid address';

  const valid =
    !errors.invoiceRef &&
    !errors.amount &&
    !errors.token &&
    !errors.dueDate &&
    !errors.tiers &&
    !errors.payoutAddress &&
    Object.keys(errors.tierRows).length === 0;
  return { valid, errors };
};
