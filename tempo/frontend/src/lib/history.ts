import type { Address, Client, Hex } from 'viem';
import { getBlock, getBlockNumber, getContractEvents } from 'viem/actions';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';
import { blockRanges } from './logs';

/** One decoded lifecycle event, reduced to what the history needs. */
export type HistoryLog =
  | { eventName: 'InvoiceCreated'; blockNumber: bigint; transactionHash: Hex; args: { seller: Address } }
  | { eventName: 'Funded'; blockNumber: bigint; transactionHash: Hex; args: { buyer: Address; refundAddress: Address; principal: bigint } }
  | {
      eventName: 'Paid';
      blockNumber: bigint;
      transactionHash: Hex;
      args: {
        caller: Address;
        payoutAddress: Address;
        toSeller: bigint;
        refundAddress: Address;
        refundToBuyer: bigint;
        discountBps: number;
      };
    }
  | { eventName: 'Cancelled'; blockNumber: bigint; transactionHash: Hex; args: { caller: Address; refunded: bigint } };

interface Step {
  timestamp: bigint;
  tx: Hex;
}

export interface InvoiceHistory {
  created?: Step & { seller: Address };
  funded?: Step & { buyer: Address; refundAddress: Address; principal: bigint };
  paid?: Step & {
    caller: Address;
    payoutAddress: Address;
    toSeller: bigint;
    refundAddress: Address;
    refundToBuyer: bigint;
    discountBps: number;
  };
  cancelled?: Step & { caller: Address; refunded: bigint };
}

/** Map decoded events to the invoice's history. `timestamps` is keyed by block number. */
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
    }
  }
  return history;
}

/** Read the invoice's lifecycle events from the factory and the invoice itself, with block timestamps. */
export async function fetchInvoiceHistory(
  client: Client,
  factory: Address,
  deployBlock: bigint,
  invoice: Address,
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
