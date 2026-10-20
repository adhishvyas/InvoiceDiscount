import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';
import { fakeClient } from './fakeChain';
import { cloneRuntime, isClone } from './invoice';

const FACTORY: Address = '0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC';
const IMPL: Address = '0xF0964E9A43664ca32b9890Ba21EB08f41933798A';
const OTHER_IMPL: Address = '0x00000000000000000000000000000000000000aa';
const CLONE: Address = '0x19d0ffbca47bfdcfe83ef9ebc6220860175b62ab';

const chain = (code: `0x${string}`) =>
  fakeClient({
    code: { [CLONE]: code },
    contracts: { [FACTORY]: { abi: invoiceFactoryAbi, reads: { implementation: IMPL } } },
  });

describe('cloneRuntime', () => {
  it('matches the code of a deployed Moderato clone', () => {
    expect(cloneRuntime(IMPL)).toBe(
      '0x363d3d373d3d3d363d73f0964e9a43664ca32b9890ba21eb08f41933798a5af43d82803e903d91602b57fd5bf3',
    );
  });
});

describe('isClone', () => {
  it('accepts a clone of the factory implementation', async () => {
    expect(await isClone(chain(cloneRuntime(IMPL)), FACTORY, CLONE)).toBe(true);
  });

  it('rejects a clone of another implementation', async () => {
    expect(await isClone(chain(cloneRuntime(OTHER_IMPL)), FACTORY, CLONE)).toBe(false);
  });

  it('rejects an address with no code', async () => {
    expect(await isClone(chain('0x'), FACTORY, CLONE)).toBe(false);
  });

  it('rejects a contract that is not a clone', async () => {
    expect(await isClone(chain('0x6080604052'), FACTORY, CLONE)).toBe(false);
  });
});
