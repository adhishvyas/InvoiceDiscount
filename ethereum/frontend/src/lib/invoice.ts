import type { ContractFunctionReturnType } from 'viem';
import type { Config } from 'wagmi';
import { readContract } from 'wagmi/actions';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';

/** The invoice's full state from `getInvoice()`, with payout and refund addresses resolved. RPC errors propagate. */
export const readInvoice = (
  config: Config,
  address: `0x${string}`,
): Promise<ContractFunctionReturnType<typeof invoiceEscrowAbi, 'view', 'getInvoice'>> =>
  readContract(config, { abi: invoiceEscrowAbi, address, functionName: 'getInvoice' });

/** The contract's `activeDiscount(timestamp)` in basis points: the first tier with `timestamp < cutoff`, or 0. */
export const readActiveDiscount = (config: Config, address: `0x${string}`, timestamp: bigint): Promise<number> =>
  readContract(config, { abi: invoiceEscrowAbi, address, functionName: 'activeDiscount', args: [timestamp] });
