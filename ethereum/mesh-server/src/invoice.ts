// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v2): exported names, signatures and documented behaviour.
import { concat, erc20Abi, getAddress, type Address, type Client, type ContractFunctionReturnType, type Hex } from 'viem';
import { getBlock, getCode, readContract } from 'viem/actions';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';
import { quoteAmount } from './quote';

/** Mirrors the contract's `Status` enum. */
export const Status = { Active: 0, Funded: 1, Paid: 2, Cancelled: 3 } as const;
export const STATUS_NAME = ['Active', 'Funded', 'Paid', 'Cancelled'] as const;

/** What `getInvoice()` returns. */
export type Invoice = ContractFunctionReturnType<typeof invoiceEscrowAbi, 'view', 'getInvoice'>;

/**
 * EIP-1167 minimal-proxy runtime code for `implementation`, lowercase:
 * `0x363d3d373d3d3d363d73` + implementation (20 bytes) + `5af43d82803e903d91602b57fd5bf3` (45 bytes in all).
 */
export function cloneRuntime(implementation: Address): Hex {
  return concat(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']).toLowerCase() as Hex;
}

const implementations = new Map<Address, Promise<Address>>();

/** The factory's implementation never changes, so it is read once per process; a failed read isn't cached. */
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

/**
 * Whether `address` is a clone of the configured factory's implementation (Mesh spec §4.3 step 1): its code
 * (`eth_getCode`) equals `cloneRuntime(factory.implementation())`, compared case-insensitively.
 * False for an address with no code, a non-clone contract, or a clone of another implementation.
 * `implementation()` is read once per factory for the process lifetime (a failed read isn't cached).
 */
export async function isClone(client: Client, factory: Address, address: Address): Promise<boolean> {
  const [code, implementation] = await Promise.all([getCode(client, { address }), implementationOf(client, factory)]);
  return code !== undefined && code.toLowerCase() === cloneRuntime(implementation);
}

/** `getInvoice()` on the clone. */
export async function readInvoice(client: Client, address: Address): Promise<Invoice> {
  return readContract(client, { address, abi: invoiceEscrowAbi, functionName: 'getInvoice' });
}

/**
 * What `settleDirect()` requires now: `quoteAmount(invoice.principal, activeDiscount(t))`, where `t` is the latest
 * block's timestamp and `activeDiscount` is called on the clone.
 */
export async function dueNow(client: Client, address: Address, invoice: Invoice): Promise<bigint> {
  const { timestamp } = await getBlock(client);
  const bps = await readContract(client, { address, abi: invoiceEscrowAbi, functionName: 'activeDiscount', args: [timestamp] });
  return quoteAmount(invoice.principal, bps);
}

/** ERC-20 `balanceOf(holder)` on `token`. */
export async function tokenBalance(client: Client, token: Address, holder: Address): Promise<bigint> {
  return readContract(client, { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
}
