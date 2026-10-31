import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceHistory } from './history';
import { isSettled, parseHistory, readCachedHistory, serializeHistory, writeCachedHistory } from './historyCache';

const SELLER = '0x00000000000000000000000000000000000000a1' as const;
const TX = `0x${'1'.repeat(64)}` as const;
const REF = `0x${'41'.padEnd(64, '0')}` as const;
const created = { timestamp: 1000n, tx: TX, seller: SELLER } as const;
const settledDirect = { timestamp: 2000n, tx: TX, caller: SELLER, invoiceRef: REF, payoutAddress: SELLER, amount: 900_000n, discountBps: 1000 };
const cancelled = { timestamp: 2000n, tx: TX, caller: SELLER, invoiceRef: REF, refunded: 0n };
const paid = {
  timestamp: 3000n,
  tx: TX,
  caller: SELLER,
  invoiceRef: REF,
  payoutAddress: SELLER,
  toSeller: 900_000n,
  refundAddress: SELLER,
  refundToBuyer: 100_000n,
  discountBps: 1000,
};

describe('historyCache', () => {
  it('round-trips bigints', () => {
    const history: InvoiceHistory = {
      created,
      cancelled: { ...cancelled, refunded: 12_345_678_901_234_567_890n },
    };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
  it('round-trips bigints beyond uint64 and zero exactly', () => {
    const big = 2n ** 200n + 1n;
    const history: InvoiceHistory = { created, settledDirect: { ...settledDirect, amount: big }, inbound: [{ timestamp: 0n, tx: TX, from: SELLER, amount: 0n }] };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
  it('round-trips an empty history and a paid one', () => {
    expect(parseHistory(serializeHistory({}))).toEqual({});
    const history: InvoiceHistory = { created, funded: { timestamp: 1500n, tx: TX, buyer: SELLER, invoiceRef: REF, refundAddress: SELLER, principal: 1_000_000n }, paid };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
  it('serializes to JSON text', () => {
    expect(() => JSON.parse(serializeHistory({ created }))).not.toThrow();
  });
  it('treats paid, cancelled or directly settled invoices as settled', () => {
    expect(isSettled({})).toBe(false);
    expect(isSettled({ created })).toBe(false);
    expect(isSettled({ created, funded: { timestamp: 1500n, tx: TX, buyer: SELLER, invoiceRef: REF, refundAddress: SELLER, principal: 1n } })).toBe(false);
    expect(isSettled({ created, paid })).toBe(true);
    expect(isSettled({ created, cancelled })).toBe(true);
    expect(isSettled({ created, settledDirect })).toBe(true);
  });
  it('round-trips a direct settlement with its inbound transfers', () => {
    const history: InvoiceHistory = {
      created,
      settledDirect,
      inbound: [{ timestamp: 1500n, tx: TX, from: SELLER, amount: 900_000n }],
    };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
});

describe('cached history in localStorage', () => {
  const INVOICE = '0xAbCdEf0000000000000000000000000000000001' as const;
  const settled: InvoiceHistory = { created, paid };
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads back a settled history it wrote', () => {
    writeCachedHistory(INVOICE, settled);
    expect(readCachedHistory(INVOICE)).toEqual(settled);
  });
  it('is keyed case-insensitively in the address', () => {
    writeCachedHistory(INVOICE, settled);
    expect(readCachedHistory(INVOICE.toLowerCase() as `0x${string}`)).toEqual(settled);
    expect(readCachedHistory(INVOICE.toUpperCase().replace('0X', '0x') as `0x${string}`)).toEqual(settled);
  });
  it('keeps invoices apart', () => {
    writeCachedHistory(INVOICE, settled);
    expect(readCachedHistory('0x0000000000000000000000000000000000000002')).toBeUndefined();
  });
  it('does not cache an invoice that can still change', () => {
    writeCachedHistory(INVOICE, { created });
    writeCachedHistory(INVOICE, {});
    expect(store.size).toBe(0);
    expect(readCachedHistory(INVOICE)).toBeUndefined();
  });
  it('returns undefined when nothing is cached', () => {
    expect(readCachedHistory(INVOICE)).toBeUndefined();
  });
  it('treats unparseable or wrongly-shaped stored data as no cache, without throwing', () => {
    writeCachedHistory(INVOICE, settled);
    const [key] = [...store.keys()];
    store.set(key, '{not json');
    expect(readCachedHistory(INVOICE)).toBeUndefined();
    store.set(key, '');
    expect(readCachedHistory(INVOICE)).toBeUndefined();
  });
  it('never throws when storage throws on read or write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => writeCachedHistory(INVOICE, settled)).not.toThrow();
    expect(readCachedHistory(INVOICE)).toBeUndefined();
  });
  it('never throws when localStorage itself is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => writeCachedHistory(INVOICE, settled)).not.toThrow();
    expect(readCachedHistory(INVOICE)).toBeUndefined();
  });
});
