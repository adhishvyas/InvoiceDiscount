import { erc20Abi, type Address, type Client, type Hex } from 'viem';
import { getBlock, getBlockNumber, getContractEvents } from 'viem/actions';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';
import { blockRanges } from './logs';

/**
 * One decoded event, reduced to what the history needs. The four escrow events carry the invoice's `invoiceRef`
 * (spec §3.6). `Transfer` is an ERC-20 transfer of the invoice's token into the invoice (a direct payment);
 * `amount` is the event's `value`.
 */
export type HistoryLog =
  | { eventName: 'InvoiceCreated'; blockNumber: bigint; transactionHash: Hex; args: { seller: Address } }
  | {
      eventName: 'Funded';
      blockNumber: bigint;
      transactionHash: Hex;
      args: { buyer: Address; invoiceRef: Hex; refundAddress: Address; principal: bigint };
    }
  | {
      eventName: 'Paid';
      blockNumber: bigint;
      transactionHash: Hex;
      args: {
        caller: Address;
        invoiceRef: Hex;
        payoutAddress: Address;
        toSeller: bigint;
        refundAddress: Address;
        refundToBuyer: bigint;
        discountBps: number;
      };
    }
  | { eventName: 'Cancelled'; blockNumber: bigint; transactionHash: Hex; args: { caller: Address; invoiceRef: Hex; refunded: bigint } }
  | {
      eventName: 'SettledDirect';
      blockNumber: bigint;
      transactionHash: Hex;
      args: { caller: Address; invoiceRef: Hex; payoutAddress: Address; amount: bigint; discountBps: number };
    }
  | { eventName: 'Transfer'; blockNumber: bigint; transactionHash: Hex; args: { from: Address; amount: bigint } };

interface Step {
  /** Block timestamp, unix seconds. */
  timestamp: bigint;
  /** Transaction hash. */
  tx: Hex;
}

/** The invoice's lifecycle, one entry per step that happened; a step that didn't happen is absent. */
export interface InvoiceHistory {
  created?: Step & { seller: Address };
  funded?: Step & { buyer: Address; invoiceRef: Hex; refundAddress: Address; principal: bigint };
  paid?: Step & {
    caller: Address;
    invoiceRef: Hex;
    payoutAddress: Address;
    toSeller: bigint;
    refundAddress: Address;
    refundToBuyer: bigint;
    discountBps: number;
  };
  cancelled?: Step & { caller: Address; invoiceRef: Hex; refunded: bigint };
  settledDirect?: Step & { caller: Address; invoiceRef: Hex; payoutAddress: Address; amount: bigint; discountBps: number };
  /** Token transfers into the invoice (the direct payment), oldest first. Read only when `settledDirect` is set. */
  inbound?: (Step & { from: Address; amount: bigint })[];
}

/**
 * Map decoded events to the invoice's history. `timestamps` is keyed by block number.
 * Each lifecycle event fills its entry with `{ timestamp, tx, ...args }`; the result doesn't depend on log order.
 * Each `Transfer` appends to `inbound`, which is sorted by timestamp, oldest first (transfers with equal timestamps
 * keep their input order), and absent when there are none. No logs gives `{}`.
 * Throws `Missing timestamp for block <n>` if a log's block is not in `timestamps`.
 */
export function buildHistory(logs: HistoryLog[], timestamps: ReadonlyMap<bigint, bigint>): InvoiceHistory {
  const history: InvoiceHistory = {};
  for (const log of logs) {
    const timestamp = timestamps.get(log.blockNumber);
    if (timestamp === undefined) throw new Error(`Missing timestamp for block ${log.blockNumber}`);
    const step = { timestamp, tx: log.transactionHash };
    switch (log.eventName) {
      case 'InvoiceCreated':
        history.created = { ...step, ...log.args };
        break;
      case 'Funded':
        history.funded = { ...step, ...log.args };
        break;
      case 'Paid':
        history.paid = { ...step, ...log.args };
        break;
      case 'Cancelled':
        history.cancelled = { ...step, ...log.args };
        break;
      case 'SettledDirect':
        history.settledDirect = { ...step, ...log.args };
        break;
      case 'Transfer':
        (history.inbound ??= []).push({ ...step, ...log.args });
        break;
    }
  }
  history.inbound?.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return history;
}

/**
 * Read the invoice's lifecycle events, with block timestamps from `getBlock`, and build its history.
 * Finds `InvoiceCreated` for `invoice` on the factory, paging from `deployBlock` ({@link blockRanges});
 * if there is none, returns `{}`. Then pages the invoice's own `Funded`, `Paid`, `Cancelled` and `SettledDirect`
 * from the creation block. After a direct settlement, also the ERC-20 `Transfer` logs of `token` with
 * `to = invoice` from the creation block, so the payer is visible. RPC errors propagate.
 */
export async function fetchInvoiceHistory(
  client: Client,
  factory: Address,
  deployBlock: bigint,
  invoice: Address,
  token: Address,
): Promise<InvoiceHistory> {
  const latest = await getBlockNumber(client);
  const logs: HistoryLog[] = [];

  let createdBlock: bigint | undefined;
  for (const [from, to] of blockRanges(deployBlock, latest)) {
    const found = await getContractEvents(client, {
      address: factory,
      abi: invoiceFactoryAbi,
      eventName: 'InvoiceCreated',
      args: { invoice },
      strict: true,
      fromBlock: from,
      toBlock: to,
    });
    if (found.length > 0) {
      const { blockNumber, transactionHash, args } = found[0];
      logs.push({ eventName: 'InvoiceCreated', blockNumber, transactionHash, args: { seller: args.seller } });
      createdBlock = blockNumber;
      break;
    }
  }
  if (createdBlock === undefined) return {};

  for (const [from, to] of blockRanges(createdBlock, latest)) {
    const found = await getContractEvents(client, { address: invoice, abi: invoiceEscrowAbi, strict: true, fromBlock: from, toBlock: to });
    for (const log of found) {
      const { blockNumber, transactionHash } = log;
      if (log.eventName === 'Funded') logs.push({ eventName: 'Funded', blockNumber, transactionHash, args: log.args });
      else if (log.eventName === 'Paid') logs.push({ eventName: 'Paid', blockNumber, transactionHash, args: log.args });
      else if (log.eventName === 'Cancelled') logs.push({ eventName: 'Cancelled', blockNumber, transactionHash, args: log.args });
      else if (log.eventName === 'SettledDirect') logs.push({ eventName: 'SettledDirect', blockNumber, transactionHash, args: log.args });
    }
  }

  if (logs.some((l) => l.eventName === 'SettledDirect')) {
    for (const [from, to] of blockRanges(createdBlock, latest)) {
      const found = await getContractEvents(client, {
        address: token,
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { to: invoice },
        strict: true,
        fromBlock: from,
        toBlock: to,
      });
      for (const { blockNumber, transactionHash, args } of found) {
        logs.push({ eventName: 'Transfer', blockNumber, transactionHash, args: { from: args.from, amount: args.value } });
      }
    }
  }

  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const timestamps = new Map<bigint, bigint>();
  await Promise.all(
    blocks.map(async (blockNumber) => {
      const block = await getBlock(client, { blockNumber });
      timestamps.set(blockNumber, block.timestamp);
    }),
  );
  return buildHistory(logs, timestamps);
}
