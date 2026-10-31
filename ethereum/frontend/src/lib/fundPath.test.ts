import { describe, expect, it } from 'vitest';
import { fundPath } from './fundPath';

describe('fundPath', () => {
  it('batches only when the wallet supports atomic calls', () => {
    expect(fundPath('supported')).toBe('batch');
  });
  it('goes sequential when the wallet would first need a 7702 upgrade', () => {
    expect(fundPath('ready')).toBe('sequential');
  });
  it('goes sequential when atomic calls are unsupported', () => {
    expect(fundPath('unsupported')).toBe('sequential');
  });
  it('goes sequential with no EIP-5792 support or Sepolia absent', () => {
    expect(fundPath(undefined)).toBe('sequential');
  });
});
