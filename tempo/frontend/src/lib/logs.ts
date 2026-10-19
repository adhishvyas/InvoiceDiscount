import type { Address, Client, Hex } from 'viem';
import { getBlockNumber, getContractEvents } from 'viem/actions';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';

/** The Moderato RPC rejects ranges over 100,000 blocks and gateway-errors at exactly that; stay well under. */
export const LOG_PAGE_SIZE = 50_000n;

/** Inclusive [from, to] block ranges covering fromBlock..toBlock in pages of `size`. */
export function blockRanges(fromBlock: bigint, toBlock: bigint, size: bigint = LOG_PAGE_SIZE): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - 1n;
    ranges.push([from, to < toBlock ? to : toBlock]);
  }
  return ranges;
}

/** The address of an invoice this seller already created with this reference, if any. */
export async function findExistingInvoice(
  client: Client,
  factory: Address,
  fromBlock: bigint,
  seller: Address,
  invoiceRef: Hex,
): Promise<Address | undefined> {
  const latest = await getBlockNumber(client);
  for (const [from, to] of blockRanges(fromBlock, latest)) {
    const logs = await getContractEvents(client, {
      address: factory,
      abi: invoiceFactoryAbi,
      eventName: 'InvoiceCreated',
      args: { seller, invoiceRef },
      fromBlock: from,
      toBlock: to,
    });
    if (logs.length > 0) return logs[0].args.invoice;
  }
  return undefined;
}
