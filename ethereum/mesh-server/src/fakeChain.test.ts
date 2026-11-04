// Self-tests of the test double. These pass against the stubs on purpose (they import no stubbed module).
import { describe, expect, it } from 'vitest';
import { erc20Abi } from 'viem';
import { getBlock, getBlockNumber, readContract, waitForTransactionReceipt } from 'viem/actions';
import { CLONE, PYUSD, T, cloneCode, makeWorld, newHash } from './fakeChain';

describe('fakeClient', () => {
  it('serves ERC-20 balanceOf and decimals', async () => {
    const world = makeWorld({ invoices: { [CLONE]: { balance: 42n } } });
    expect(await readContract(world.client, { address: PYUSD, abi: erc20Abi, functionName: 'balanceOf', args: [CLONE] })).toBe(42n);
    expect(await readContract(world.client, { address: PYUSD, abi: erc20Abi, functionName: 'decimals' })).toBe(6);
  });

  it('serves the block timestamp and an advancing block number', async () => {
    const world = makeWorld();
    expect((await getBlock(world.client)).timestamp).toBe(T);
    const a = await getBlockNumber(world.client);
    expect(await getBlockNumber(world.client)).toBeGreaterThan(a);
  });

  it('finds a success and a reverted receipt, and a late one', async () => {
    const world = makeWorld();
    const ok = newHash();
    const bad = newHash();
    const late = newHash();
    world.receipts[ok] = { status: 'success' };
    world.receipts[bad] = { status: 'reverted' };
    expect((await waitForTransactionReceipt(world.client, { hash: ok })).status).toBe('success');
    expect((await waitForTransactionReceipt(world.client, { hash: bad })).status).toBe('reverted');
    setTimeout(() => (world.receipts[late] = { status: 'success' }), 30);
    expect((await waitForTransactionReceipt(world.client, { hash: late, timeout: 2000 })).status).toBe('success');
  });

  it('times out on a receipt that never appears', async () => {
    const world = makeWorld();
    await expect(waitForTransactionReceipt(world.client, { hash: newHash(), timeout: 100 })).rejects.toThrow();
  });

  it('builds the clone runtime code', () => {
    expect(cloneCode('0x1619ba96564c733204173cc201f1b9d3ab9280d1')).toHaveLength(92);
  });
});
