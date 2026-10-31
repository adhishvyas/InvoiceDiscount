/** The contract's `TooManyTiers` limit. */
export const MAX_TIERS = 10;

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
  throw new Error('unimplemented');
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
  throw new Error('unimplemented');
};
