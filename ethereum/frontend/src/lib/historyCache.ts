import type { Address } from 'viem';
import type { InvoiceHistory } from './history';

/** JSON text for a history; bigints are encoded so that {@link parseHistory} restores them exactly. */
export const serializeHistory = (history: InvoiceHistory): string => {
  throw new Error('unimplemented');
};

/** Inverse of {@link serializeHistory}: `parseHistory(serializeHistory(h))` deep-equals `h`, bigints included. */
export const parseHistory = (text: string): InvoiceHistory => {
  throw new Error('unimplemented');
};

/**
 * A settled invoice (paid, settled directly, or cancelled) never changes, so its history is cached.
 * True when `paid`, `settledDirect` or `cancelled` is set; false for `{}` or a created/funded-only history.
 */
export const isSettled = (history: InvoiceHistory): boolean => {
  throw new Error('unimplemented');
};

/**
 * The cached history for `invoice` from `localStorage` (key case-insensitive in the address), if any.
 * Per-viewer speed-up only; storage may be unavailable or hold bad data, so every failure means "no cache"
 * (`undefined`), never a throw.
 */
export function readCachedHistory(invoice: Address): InvoiceHistory | undefined {
  throw new Error('unimplemented');
}

/**
 * Caches `history` for `invoice` in `localStorage`, only if {@link isSettled}; otherwise does nothing.
 * Storage that is unavailable or full is ignored, never a throw.
 */
export function writeCachedHistory(invoice: Address, history: InvoiceHistory): void {
  throw new Error('unimplemented');
}
