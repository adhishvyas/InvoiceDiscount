import type { Address } from 'viem';
import type { InvoiceHistory } from './history';

const key = (invoice: Address) => `invoice-history:${invoice.toLowerCase()}`;

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v !== null && typeof v === 'object' && '$bigint' in v ? BigInt((v as { $bigint: string }).$bigint) : v;

export const serializeHistory = (history: InvoiceHistory) => JSON.stringify(history, replacer);
export const parseHistory = (text: string) => JSON.parse(text, reviver) as InvoiceHistory;

/** A settled invoice (paid or cancelled) never changes, so its history is cached. */
export const isSettled = (history: InvoiceHistory) => history.paid !== undefined || history.cancelled !== undefined;

/** Per-viewer speed-up only; storage may be unavailable or hold bad data, so every failure means "no cache". */
export function readCachedHistory(invoice: Address): InvoiceHistory | undefined {
  try {
    const text = localStorage.getItem(key(invoice));
    return text === null ? undefined : parseHistory(text);
  } catch {
    return undefined;
  }
}

export function writeCachedHistory(invoice: Address, history: InvoiceHistory) {
  if (!isSettled(history)) return;
  try {
    localStorage.setItem(key(invoice), serializeHistory(history));
  } catch {
    // storage unavailable or full: skip caching
  }
}
