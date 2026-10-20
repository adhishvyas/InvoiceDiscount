import { concat, getAddress, type Address, type Client, type Hex } from 'viem';
import { getCode, readContract } from 'viem/actions';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';

/** Mirrors the contract's `Status` enum. */
export const Status = { Active: 0, Funded: 1, Paid: 2, Cancelled: 3 } as const;
export const STATUS_NAME = ['Active', 'Funded', 'Paid', 'Cancelled'] as const;

/** EIP-1167 minimal-proxy runtime for `implementation` (45 bytes; verified against a Moderato clone). */
export const cloneRuntime = (implementation: Address): Hex =>
  concat(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']).toLowerCase() as Hex;

const implementations = new Map<Address, Promise<Address>>();

/** The factory's implementation never changes, so it is read once per process. */
function implementationOf(client: Client, factory: Address): Promise<Address> {
  const key = getAddress(factory);
  let impl = implementations.get(key);
  if (!impl) {
    impl = readContract(client, { address: factory, abi: invoiceFactoryAbi, functionName: 'implementation' });
    impl.catch(() => implementations.delete(key));
    implementations.set(key, impl);
  }
  return impl;
}

/** Whether `address` is a clone of the configured factory's implementation (MPP spec §4.3 step 2). */
export async function isClone(client: Client, factory: Address, address: Address): Promise<boolean> {
  const [code, implementation] = await Promise.all([getCode(client, { address }), implementationOf(client, factory)]);
  return code !== undefined && code.toLowerCase() === cloneRuntime(implementation);
}

export const readInvoice = (client: Client, address: Address) =>
  readContract(client, { address, abi: invoiceEscrowAbi, functionName: 'getInvoice' });

export type Invoice = Awaited<ReturnType<typeof readInvoice>>;
