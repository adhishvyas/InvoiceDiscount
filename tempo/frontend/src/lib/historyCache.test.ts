import { describe, expect, it } from 'vitest';
import type { InvoiceHistory } from './history';
import { isSettled, parseHistory, serializeHistory } from './historyCache';

const SELLER = '0x00000000000000000000000000000000000000a1' as const;
const TX = `0x${'1'.repeat(64)}` as const;
const created = { timestamp: 1000n, tx: TX, seller: SELLER } as const;
const settledDirect = { timestamp: 2000n, tx: TX, caller: SELLER, payoutAddress: SELLER, amount: 900_000n, discountBps: 1000 };

describe('historyCache', () => {
  it('round-trips bigints', () => {
    const history: InvoiceHistory = {
      created,
      cancelled: { timestamp: 2000n, tx: TX, caller: SELLER, refunded: 12_345_678_901_234_567_890n },
    };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
  it('treats only paid or cancelled invoices as settled', () => {
    expect(isSettled({})).toBe(false);
    expect(isSettled({ created })).toBe(false);
    expect(isSettled({ created, cancelled: { timestamp: 2000n, tx: TX, caller: SELLER, refunded: 0n } })).toBe(true);
    expect(isSettled({ created, settledDirect })).toBe(true);
  });
  it('round-trips a direct settlement with its inbound transfers', () => {
    const history: InvoiceHistory = {
      created,
      settledDirect,
      inbound: [{ timestamp: 1500n, tx: TX, from: SELLER, amount: 900_000n, memo: TX }],
    };
    expect(parseHistory(serializeHistory(history))).toEqual(history);
  });
});
