import { describe, expect, it } from 'vitest';
import { fundPath } from './fundPath';

const ERC20 = '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9';

describe('fundPath', () => {
  it('batches only when the wallet supports atomic calls', () => {
    expect(fundPath('supported', ERC20)).toBe('batch');
  });
  it('goes sequential when the wallet would first need a 7702 upgrade', () => {
    expect(fundPath('ready', ERC20)).toBe('sequential');
  });
  it('goes sequential when atomic calls are unsupported', () => {
    expect(fundPath('unsupported', ERC20)).toBe('sequential');
  });
  it('goes sequential with no EIP-5792 support or Sepolia absent', () => {
    expect(fundPath(undefined, ERC20)).toBe('sequential');
  });
});

describe('fundPath for native ETH', () => {
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const statuses = ['supported', 'ready', 'unsupported', undefined] as const;
  it('is native for every atomic status, including undefined', () => {
    for (const s of statuses) expect(fundPath(s, NATIVE), String(s)).toBe('native');
  });
  it('is case-insensitive on the token', () => {
    for (const s of statuses) expect(fundPath(s, '0X0000000000000000000000000000000000000000'), String(s)).toBe('native');
  });
  it('leaves ERC-20 behaviour unchanged next to a native call', () => {
    expect(fundPath('supported', ERC20)).toBe('batch');
    expect(fundPath('ready', ERC20)).toBe('sequential');
    expect(fundPath('unsupported', ERC20)).toBe('sequential');
    expect(fundPath(undefined, ERC20)).toBe('sequential');
    expect(fundPath('supported', '0x0000000000000000000000000000000000000001')).toBe('batch');
  });
});
