import type { Config } from 'wagmi';
import { readContract } from 'wagmi/actions';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';

export const readInvoice = (config: Config, address: `0x${string}`) =>
  readContract(config, { abi: invoiceEscrowAbi, address, functionName: 'getInvoice' });

export const readActiveDiscount = (config: Config, address: `0x${string}`, timestamp: bigint) =>
  readContract(config, { abi: invoiceEscrowAbi, address, functionName: 'activeDiscount', args: [timestamp] });
