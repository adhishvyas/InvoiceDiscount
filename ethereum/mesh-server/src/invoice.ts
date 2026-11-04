// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import type { Address, Client, ContractFunctionReturnType, Hex } from 'viem';
import type { invoiceEscrowAbi } from './abi/InvoiceEscrow';

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
  throw new Error('unimplemented');
}

/**
 * Whether `address` is a clone of the configured factory's implementation (Mesh spec §4.3 step 1): its code
 * (`eth_getCode`) equals `cloneRuntime(factory.implementation())`, compared case-insensitively.
 * False for an address with no code, a non-clone contract, or a clone of another implementation.
 * `implementation()` is read once per factory for the process lifetime (a failed read isn't cached).
 */
export async function isClone(client: Client, factory: Address, address: Address): Promise<boolean> {
  throw new Error('unimplemented');
}

/** `getInvoice()` on the clone. */
export async function readInvoice(client: Client, address: Address): Promise<Invoice> {
  throw new Error('unimplemented');
}

/**
 * What `settleDirect()` requires now: `quoteAmount(invoice.principal, activeDiscount(t))`, where `t` is the latest
 * block's timestamp and `activeDiscount` is called on the clone.
 */
export async function dueNow(client: Client, address: Address, invoice: Invoice): Promise<bigint> {
  throw new Error('unimplemented');
}

/** `token` meaning native ETH (an ETH invoice's `getInvoice().token`, native-ETH spec §2). */
export const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000';

/**
 * `holder`'s balance of `token`: for `NATIVE_TOKEN`, the ETH balance (`eth_getBalance` at the latest block);
 * otherwise ERC-20 `balanceOf(holder)` on `token`. Addresses compare case-insensitively.
 */
export async function tokenBalance(client: Client, token: Address, holder: Address): Promise<bigint> {
  throw new Error('unimplemented');
}

/** Decimals of `token`: 18 for `NATIVE_TOKEN` (no chain call), otherwise ERC-20 `decimals()` on `token`. */
export async function tokenDecimals(client: Client, token: Address): Promise<number> {
  throw new Error('unimplemented');
}
