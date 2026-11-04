import { describe, expect, it } from 'vitest';
import { NATIVE_DECIMALS, NATIVE_TOKEN, isNative } from './tokens';

describe('tokens', () => {
  it('NATIVE_TOKEN is the zero address and NATIVE_DECIMALS is 18', () => {
    expect(NATIVE_TOKEN).toBe('0x0000000000000000000000000000000000000000');
    expect(NATIVE_DECIMALS).toBe(18);
  });
  it('isNative is true for the zero address', () => {
    expect(isNative(NATIVE_TOKEN)).toBe(true);
    expect(isNative('0x0000000000000000000000000000000000000000')).toBe(true);
  });
  it('isNative is case-insensitive', () => {
    expect(isNative('0X0000000000000000000000000000000000000000')).toBe(true);
    expect(isNative(NATIVE_TOKEN.toUpperCase())).toBe(true);
  });
  it('isNative is false for ERC-20 addresses', () => {
    expect(isNative('0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9')).toBe(false);
    expect(isNative('0x0000000000000000000000000000000000000001')).toBe(false);
    expect(isNative('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')).toBe(false);
  });
  it('isNative is false for the empty string and non-addresses', () => {
    expect(isNative('')).toBe(false);
    expect(isNative('0x')).toBe(false);
    expect(isNative('0x0')).toBe(false);
    expect(isNative('ETH')).toBe(false);
    expect(isNative('0x00000000000000000000000000000000000000000')).toBe(false);
    expect(isNative('0x000000000000000000000000000000000000000g')).toBe(false);
  });
});
