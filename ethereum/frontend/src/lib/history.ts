import type { Address, Client, Hex } from 'viem';

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
  throw new Error('unimplemented');
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
  throw new Error('unimplemented');
}
