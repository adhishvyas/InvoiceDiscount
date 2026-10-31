import { isAddress } from 'viem';
import { REF_MAX_BYTES, refByteLength } from './ref';
import { toUnits } from './units';

/** The contract's `TooManyTiers` limit. */
export const MAX_TIERS = 10;
const UINT128_MAX = (1n << 128n) - 1n;

/** One discount tier row of the create form. */
export interface TierInput {
  /** Unix seconds, or null if not chosen yet. */
  cutoff: number | null;
  /** Percent as typed, e.g. "15" or "12.5" (at most 2 decimals). */
  discountPercent: string;
}

/** The create form as typed. */
export interface InvoiceFormInput {
  invoiceRef: string;
  amount: string;
  token: string;
  /** The selected token's `decimals()`. */
  decimals: number;
  /** Unix seconds, or null if not chosen yet. */
  dueDate: number | null;
  tiers: TierInput[];
  /** Empty means "pay the connected wallet". */
  payoutAddress: string;
}

/** One human-readable message per invalid field; a field is absent when it is valid. */
export interface FormErrors {
  invoiceRef?: string;
  amount?: string;
  token?: string;
  dueDate?: string;
  /** Too many tiers. */
  tiers?: string;
  /** Per-row errors, keyed by the row's index in `tiers`; rows without errors are absent. */
  tierRows: Record<number, { cutoff?: string; discount?: string }>;
  payoutAddress?: string;
}

/**
 * "15" or "12.5" to basis points (1500, 1250). Surrounding whitespace is ignored.
 * Returns null unless the string is digits with an optional `.` and 1–2 decimals: `''`, `'-1'`, `'1.234'`, `'1,5'`
 * and `'.5'` are all null. Does not cap at 100% (`'150'` is 15000); `validateInvoiceForm` does.
 */
export const percentToBps = (percent: string): number | null => {
  const s = percent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
};

/**
 * Mirrors the contract's initialize checks (spec §3.5) so the form can block a failing transaction.
 * `valid` is true only when `errors` has no field messages and `tierRows` is empty. Checks:
 * - `invoiceRef`: trimmed, 1 to 32 UTF-8 bytes.
 * - `amount`: digits with at most `decimals` decimals (trimmed), greater than 0 and at most uint128 max in base units.
 * - `token`: a valid address.
 * - `dueDate`: set and strictly after `nowSec`.
 * - `tiers`: at most {@link MAX_TIERS} (`errors.tiers`). Per row: a cutoff is set, strictly above the previous
 *   set cutoff (the first above 0), and at most `dueDate` (equal is allowed); the percent parses with
 *   {@link percentToBps} and is at most 100%. Past cutoffs are allowed, as on-chain.
 * - `payoutAddress`: empty or whitespace-only, or a valid address.
 */
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
