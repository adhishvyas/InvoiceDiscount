import type { Address, Client, Hex } from 'viem';
import { getBlockNumber, getContractEvents } from 'viem/actions';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';

/**
 * Blocks per `eth_getLogs` request. The public Sepolia node allows 50,000 and paid providers about 10,000;
 * Alchemy's free tier (10) can't be used (verification notes item 3).
 */
export const LOG_PAGE_SIZE = 10_000n;

/**
 * Inclusive [from, to] block ranges covering fromBlock..toBlock in order, each at most `size` blocks
 * (`to - from < size`), with no gaps or overlaps; the last one ends at `toBlock`.
 * `fromBlock === toBlock` gives one single-block range; `fromBlock > toBlock` gives `[]`.
 * @example blockRanges(0n, 200n, 100n) → [[0n, 99n], [100n, 199n], [200n, 200n]]
 */
export function blockRanges(fromBlock: bigint, toBlock: bigint, size: bigint = LOG_PAGE_SIZE): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - 1n;
    ranges.push([from, to < toBlock ? to : toBlock]);
  }
  return ranges;
}

/**
 * The address of an invoice this seller already created with this reference, if any (spec §5.4).
 * Pages through the factory's `InvoiceCreated` logs, filtered by the indexed `seller` and `invoiceRef`,
 * from `fromBlock` to the latest block in {@link blockRanges}, and returns the first match's `invoice`.
 * Stops at the first page with a match. RPC errors propagate.
 */
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
