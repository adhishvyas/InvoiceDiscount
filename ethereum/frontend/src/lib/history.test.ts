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
