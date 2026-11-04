import { describe, expect, it } from 'vitest';
import { buildHistory, type HistoryLog } from './history';

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b2';
const REFUND = '0x00000000000000000000000000000000000000c3';
const REF = `0x${'41'.padEnd(64, '0')}` as const;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const created: HistoryLog = { eventName: 'InvoiceCreated', blockNumber: 10n, transactionHash: tx(1), args: { seller: SELLER } };
const funded: HistoryLog = {
  eventName: 'Funded',
  blockNumber: 20n,
  transactionHash: tx(2),
  args: { buyer: BUYER, invoiceRef: REF, refundAddress: REFUND, principal: 1_000_000n },
};
const paid: HistoryLog = {
  eventName: 'Paid',
  blockNumber: 30n,
  transactionHash: tx(3),
  args: {
    caller: BUYER,
    invoiceRef: REF,
    payoutAddress: SELLER,
    toSeller: 900_000n,
    refundAddress: REFUND,
    refundToBuyer: 100_000n,
    discountBps: 1000,
  },
};
const cancelled: HistoryLog = {
  eventName: 'Cancelled',
  blockNumber: 25n,
  transactionHash: tx(4),
  args: { caller: SELLER, invoiceRef: REF, refunded: 0n },
};
const PAYER = '0x00000000000000000000000000000000000000d4';
const inbound = (blockNumber: bigint, n: number, amount: bigint): HistoryLog => ({
  eventName: 'Transfer',
  blockNumber,
  transactionHash: tx(n),
  args: { from: PAYER, amount },
});
const settledDirect: HistoryLog = {
  eventName: 'SettledDirect',
  blockNumber: 40n,
  transactionHash: tx(6),
  args: { caller: SELLER, invoiceRef: REF, payoutAddress: SELLER, amount: 900_000n, discountBps: 1000 },
};
const timestamps = new Map([[10n, 1000n], [20n, 2000n], [25n, 2500n], [30n, 3000n], [35n, 3500n], [38n, 3800n], [40n, 4000n]]);

describe('buildHistory', () => {
  it('is empty with no events', () => {
    expect(buildHistory([], timestamps)).toEqual({});
  });
  it('maps a paid invoice with timestamps, txs, amounts and invoiceRef', () => {
    expect(buildHistory([created, funded, paid], timestamps)).toEqual({
      created: { timestamp: 1000n, tx: tx(1), seller: SELLER },
      funded: { timestamp: 2000n, tx: tx(2), buyer: BUYER, invoiceRef: REF, refundAddress: REFUND, principal: 1_000_000n },
      paid: {
        timestamp: 3000n,
        tx: tx(3),
        caller: BUYER,
        invoiceRef: REF,
        payoutAddress: SELLER,
        toSeller: 900_000n,
        refundAddress: REFUND,
        refundToBuyer: 100_000n,
        discountBps: 1000,
      },
    });
  });
  it('maps an invoice cancelled before funding', () => {
    const history = buildHistory([created, cancelled], timestamps);
    expect(history.funded).toBeUndefined();
    expect(history.cancelled).toEqual({ timestamp: 2500n, tx: tx(4), caller: SELLER, invoiceRef: REF, refunded: 0n });
  });
  it('maps an invoice funded and then cancelled', () => {
    const history = buildHistory([created, funded, cancelled], timestamps);
    expect(history.funded?.timestamp).toBe(2000n);
    expect(history.cancelled?.timestamp).toBe(2500n);
    expect(history.paid).toBeUndefined();
  });
  it('does not depend on log order', () => {
    expect(buildHistory([paid, created, funded], timestamps)).toEqual(buildHistory([created, funded, paid], timestamps));
  });
  it('omits steps that did not happen, rather than setting them to undefined', () => {
    const history = buildHistory([created], timestamps);
    expect(Object.keys(history)).toEqual(['created']);
  });
  it('throws when a block timestamp is missing', () => {
    expect(() => buildHistory([paid], new Map())).toThrow('Missing timestamp for block 30');
  });
  it('throws when only a Transfer log lacks its block timestamp', () => {
    expect(() => buildHistory([created, inbound(99n, 9, 1n)], timestamps)).toThrow('Missing timestamp for block 99');
  });
  it('maps a direct settlement with the inbound transfers, oldest first', () => {
    const history = buildHistory([settledDirect, inbound(38n, 7, 400_000n), created, inbound(35n, 5, 500_000n)], timestamps);
    expect(history.funded).toBeUndefined();
    expect(history.paid).toBeUndefined();
    expect(history.settledDirect).toEqual({
      timestamp: 4000n,
      tx: tx(6),
      caller: SELLER,
      invoiceRef: REF,
      payoutAddress: SELLER,
      amount: 900_000n,
      discountBps: 1000,
    });
    expect(history.inbound).toEqual([
      { timestamp: 3500n, tx: tx(5), from: PAYER, amount: 500_000n },
      { timestamp: 3800n, tx: tx(7), from: PAYER, amount: 400_000n },
    ]);
  });
  it('sorts inbound by timestamp, not by block number order in the input or the block number itself', () => {
    const history = buildHistory(
      [inbound(40n, 8, 3n), inbound(10n, 9, 1n), inbound(25n, 10, 2n)],
      timestamps,
    );
    expect(history.inbound?.map((i) => i.amount)).toEqual([1n, 2n, 3n]);
  });
  it('keeps input order for inbound transfers with equal timestamps', () => {
    const same = new Map([[50n, 5000n], [51n, 5000n]]);
    const history = buildHistory([inbound(51n, 1, 11n), inbound(50n, 2, 22n), inbound(51n, 3, 33n)], same);
    expect(history.inbound?.map((i) => i.amount)).toEqual([11n, 22n, 33n]);
  });
  it('has no inbound list without inbound transfers', () => {
    expect(buildHistory([created, paid], timestamps).inbound).toBeUndefined();
  });
});

describe('buildHistory for native ETH', () => {
  const received = (blockNumber: bigint, n: number, amount: bigint): HistoryLog => ({
    eventName: 'Received',
    blockNumber,
    transactionHash: tx(n),
    args: { from: PAYER, invoiceRef: REF, amount },
  });
  const deferred = (blockNumber: bigint, n: number, amount: bigint, to: `0x${string}` = SELLER): HistoryLog => ({
    eventName: 'PayoutDeferred',
    blockNumber,
    transactionHash: tx(n),
    args: { to, invoiceRef: REF, amount },
  });
  const withdrawn = (blockNumber: bigint, n: number, amount: bigint, account: `0x${string}` = SELLER, to: `0x${string}` = REFUND): HistoryLog => ({
    eventName: 'Withdrawn',
    blockNumber,
    transactionHash: tx(n),
    args: { account, to, amount },
  });

  it('maps Received to an inbound entry without invoiceRef', () => {
    const h = buildHistory([received(35n, 5, 7n)], timestamps);
    expect(h.inbound).toEqual([{ timestamp: 3500n, tx: tx(5), from: PAYER, amount: 7n }]);
    expect(Object.keys(h.inbound![0]).sort()).toEqual(['amount', 'from', 'timestamp', 'tx']);
  });
  it('maps PayoutDeferred to deferred', () => {
    const h = buildHistory([deferred(30n, 8, 5n, BUYER)], timestamps);
    expect(h.deferred).toEqual([{ timestamp: 3000n, tx: tx(8), to: BUYER, amount: 5n }]);
    expect(h.inbound).toBeUndefined();
    expect(h.withdrawals).toBeUndefined();
  });
  it('maps Withdrawn to withdrawals', () => {
    const h = buildHistory([withdrawn(38n, 9, 6n, SELLER, BUYER)], timestamps);
    expect(h.withdrawals).toEqual([{ timestamp: 3800n, tx: tx(9), account: SELLER, to: BUYER, amount: 6n }]);
    expect(h.deferred).toBeUndefined();
  });
  it('sorts each list oldest first, keeping input order for equal timestamps', () => {
    const h = buildHistory(
      [received(40n, 1, 3n), received(10n, 2, 1n), received(25n, 3, 2n), deferred(40n, 4, 30n), deferred(20n, 5, 20n), withdrawn(35n, 6, 300n), withdrawn(30n, 7, 200n)],
      timestamps,
    );
    expect(h.inbound?.map((i) => i.amount)).toEqual([1n, 2n, 3n]);
    expect(h.deferred?.map((i) => i.amount)).toEqual([20n, 30n]);
    expect(h.withdrawals?.map((i) => i.amount)).toEqual([200n, 300n]);
    const same = new Map([[50n, 5000n], [51n, 5000n]]);
    const t = buildHistory(
      [received(51n, 1, 11n), received(50n, 2, 22n), deferred(51n, 3, 1n), deferred(50n, 4, 2n), withdrawn(51n, 5, 7n), withdrawn(50n, 6, 8n)],
      same,
    );
    expect(t.inbound?.map((i) => i.amount)).toEqual([11n, 22n]);
    expect(t.deferred?.map((i) => i.amount)).toEqual([1n, 2n]);
    expect(t.withdrawals?.map((i) => i.amount)).toEqual([7n, 8n]);
  });
  it('mixes Transfer and Received in one inbound list sorted by timestamp', () => {
    const h = buildHistory([received(38n, 1, 2n), inbound(35n, 2, 1n), received(40n, 3, 3n)], timestamps);
    expect(h.inbound?.map((i) => i.amount)).toEqual([1n, 2n, 3n]);
  });
  it('omits the lists when empty', () => {
    const h = buildHistory([created, funded], timestamps);
    expect(Object.keys(h).sort()).toEqual(['created', 'funded']);
  });
  it('throws on a missing timestamp for each new event', () => {
    expect(() => buildHistory([received(99n, 1, 1n)], timestamps)).toThrow('Missing timestamp for block 99');
    expect(() => buildHistory([deferred(98n, 1, 1n)], timestamps)).toThrow('Missing timestamp for block 98');
    expect(() => buildHistory([withdrawn(97n, 1, 1n)], timestamps)).toThrow('Missing timestamp for block 97');
  });
  it('does not depend on log order for lifecycle events alongside the new ones', () => {
    const logs = [created, funded, deferred(30n, 8, 5n), settledDirect, received(35n, 5, 9n)];
    const h = buildHistory(logs, timestamps);
    expect(buildHistory([...logs].reverse(), timestamps).settledDirect).toEqual(h.settledDirect);
    expect(buildHistory([...logs].reverse(), timestamps).created).toEqual(h.created);
    expect(h.deferred).toHaveLength(1);
    expect(h.inbound).toHaveLength(1);
  });
});

