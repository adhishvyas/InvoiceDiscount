import type { Address } from 'viem';
import type { InvoiceHistory } from './history';

const key = (invoice: Address) => `invoice-history:${invoice.toLowerCase()}`;

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v !== null && typeof v === 'object' && '$bigint' in v ? BigInt((v as { $bigint: string }).$bigint) : v;

/** JSON text for a history; bigints are encoded so that {@link parseHistory} restores them exactly. */
export const serializeHistory = (history: InvoiceHistory): string => JSON.stringify(history, replacer);

/** Inverse of {@link serializeHistory}: `parseHistory(serializeHistory(h))` deep-equals `h`, bigints included. */
export const parseHistory = (text: string): InvoiceHistory => JSON.parse(text, reviver) as InvoiceHistory;

/**
 * A settled invoice (paid, settled directly, or cancelled) never changes, so its history is cached.
 * True when `paid`, `settledDirect` or `cancelled` is set; false for `{}` or a created/funded-only history.
 */
export const isSettled = (history: InvoiceHistory): boolean =>
  history.paid !== undefined || history.settledDirect !== undefined || history.cancelled !== undefined;

/**
 * The cached history for `invoice` from `localStorage` (key case-insensitive in the address), if any.
 * Per-viewer speed-up only; storage may be unavailable or hold bad data, so every failure means "no cache"
 * (`undefined`), never a throw.
 */
export function readCachedHistory(invoice: Address): InvoiceHistory | undefined {
  try {
    const text = localStorage.getItem(key(invoice));
    return text === null ? undefined : parseHistory(text);
  } catch {
    return undefined;
  }
}

/**
 * Caches `history` for `invoice` in `localStorage`, only if {@link isSettled}; otherwise does nothing.
 * Storage that is unavailable or full is ignored, never a throw.
 */
export function writeCachedHistory(invoice: Address, history: InvoiceHistory): void {
  if (!isSettled(history)) return;
  try {
    localStorage.setItem(key(invoice), serializeHistory(history));
  } catch {
    // storage unavailable or full: skip caching
  }
}
