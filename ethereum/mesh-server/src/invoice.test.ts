import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';
import { CLONE, DEFAULT_TIERS, IMPL, PYUSD, T, cloneCode, fakeClient, makeWorld } from './fakeChain';
import { cloneRuntime, dueNow, isClone, readInvoice, tokenBalance } from './invoice';

// The clone cache is per factory for the process lifetime, so every scenario that varies the implementation uses
// its own factory address.
const factory = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const OTHER_IMPL: Address = '0x00000000000000000000000000000000000000aa';
const SEPOLIA_CLONE: Address = '0x2814a70fd45740cc23ff519e66e546804fb9201c';
const SEPOLIA_IMPL: Address = '0x1619ba96564c733204173cC201f1B9D3Ab9280d1';

const chain = (f: Address, code: `0x${string}`, impl: Address = IMPL) =>
  fakeClient({
    code: { [CLONE]: code },
    contracts: { [f]: { abi: invoiceFactoryAbi, reads: { implementation: impl } } },
  });

describe('cloneRuntime', () => {
  it('matches the EIP-1167 runtime of the deployed Sepolia clone, in lowercase', () => {
    expect(cloneRuntime(SEPOLIA_IMPL)).toBe(
      '0x363d3d373d3d3d363d731619ba96564c733204173cc201f1b9d3ab9280d15af43d82803e903d91602b57fd5bf3',
    );
    expect(cloneRuntime(SEPOLIA_IMPL)).toBe(cloneCode(SEPOLIA_IMPL));
  });

  it('is 45 bytes', () => {
    expect((cloneRuntime(IMPL).length - 2) / 2).toBe(45);
  });
});

describe('isClone', () => {
  it('accepts a clone of the factory implementation', async () => {
    expect(await isClone(chain(factory(1), cloneRuntime(IMPL)), factory(1), CLONE)).toBe(true);
  });

  it('accepts the Sepolia clone address with its real implementation', async () => {
    const client = fakeClient({
      code: { [SEPOLIA_CLONE]: cloneRuntime(SEPOLIA_IMPL) },
      contracts: { [factory(2)]: { abi: invoiceFactoryAbi, reads: { implementation: SEPOLIA_IMPL } } },
    });
    expect(await isClone(client, factory(2), SEPOLIA_CLONE)).toBe(true);
  });

  it('compares the code case-insensitively', async () => {
    const upper = `0x${cloneRuntime(IMPL).slice(2).toUpperCase()}` as `0x${string}`;
    expect(await isClone(chain(factory(3), upper), factory(3), CLONE)).toBe(true);
  });

  it('rejects a clone of another implementation', async () => {
    expect(await isClone(chain(factory(4), cloneRuntime(OTHER_IMPL)), factory(4), CLONE)).toBe(false);
  });

  it('rejects an address with no code', async () => {
    expect(await isClone(chain(factory(5), '0x'), factory(5), CLONE)).toBe(false);
  });

  it('rejects a contract that is not a clone', async () => {
    expect(await isClone(chain(factory(6), '0x6080604052'), factory(6), CLONE)).toBe(false);
  });

  it('rejects code that merely starts like a clone, or has trailing bytes', async () => {
    expect(await isClone(chain(factory(7), `${cloneRuntime(IMPL)}00`), factory(7), CLONE)).toBe(false);
    expect(await isClone(chain(factory(8), cloneRuntime(IMPL).slice(0, -2) as `0x${string}`), factory(8), CLONE)).toBe(false);
  });

  it('reads implementation() once per factory', async () => {
    let reads = 0;
    const client = fakeClient({
      code: { [CLONE]: cloneRuntime(IMPL) },
      contracts: {
        [factory(9)]: {
          abi: invoiceFactoryAbi,
          reads: {
            implementation: () => {
              reads++;
              return IMPL;
            },
          },
        },
      },
    });
    expect(await isClone(client, factory(9), CLONE)).toBe(true);
    expect(await isClone(client, factory(9), CLONE)).toBe(true);
    expect(reads).toBe(1);
  });

  it('does not cache a failed implementation() read', async () => {
    let reads = 0;
    const client = fakeClient({
      code: { [CLONE]: cloneRuntime(IMPL) },
      contracts: {
        [factory(10)]: {
          abi: invoiceFactoryAbi,
          reads: {
            implementation: () => {
              if (reads++ === 0) throw new Error('rpc down');
              return IMPL;
            },
          },
        },
      },
    });
    await isClone(client, factory(10), CLONE).catch(() => undefined);
    expect(await isClone(client, factory(10), CLONE)).toBe(true);
  });

  it('keeps one implementation per factory', async () => {
    const client = fakeClient({
      code: { [CLONE]: cloneRuntime(IMPL) },
      contracts: {
        [factory(11)]: { abi: invoiceFactoryAbi, reads: { implementation: IMPL } },
        [factory(12)]: { abi: invoiceFactoryAbi, reads: { implementation: OTHER_IMPL } },
      },
    });
    expect(await isClone(client, factory(11), CLONE)).toBe(true);
    expect(await isClone(client, factory(12), CLONE)).toBe(false);
  });
});

describe('readInvoice', () => {
  it('returns the getInvoice() struct', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { status: 1, principal: 123n } } });
    const invoice = await readInvoice(world.client, CLONE);
    expect(invoice.status).toBe(1);
    expect(invoice.principal).toBe(123n);
    expect(invoice.token.toLowerCase()).toBe(PYUSD.toLowerCase());
    expect(invoice.tiers).toHaveLength(DEFAULT_TIERS.length);
  });
});

describe('dueNow', () => {
  it('is the principal less the discount at the latest block timestamp', async () => {
    const world = makeWorld();
    const invoice = await readInvoice(world.client, CLONE);
    expect(await dueNow(world.client, CLONE, invoice)).toBe(85_000_000n); // 15% at T
    world.chain.timestamp = T + 100n; // first tier's cutoff has passed
    expect(await dueNow(world.client, CLONE, invoice)).toBe(90_000_000n);
    world.chain.timestamp = T + 2000n; // past the last tier
    expect(await dueNow(world.client, CLONE, invoice)).toBe(100_000_000n);
  });

  it('uses the principal of the invoice it is given', async () => {
    const world = makeWorld();
    const invoice = await readInvoice(world.client, CLONE);
    expect(await dueNow(world.client, CLONE, { ...invoice, principal: 200_000_000n })).toBe(170_000_000n);
  });
});

describe('tokenBalance', () => {
  it('reads ERC-20 balanceOf', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { balance: 7_654_321n } } });
    expect(await tokenBalance(world.client, PYUSD, CLONE)).toBe(7_654_321n);
    expect(await tokenBalance(world.client, PYUSD, '0x00000000000000000000000000000000000000dd')).toBe(0n);
  });
});
