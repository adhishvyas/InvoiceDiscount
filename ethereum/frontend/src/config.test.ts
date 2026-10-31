import { isAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configModule from './config';
import { DEFAULT_TOKEN, ETH_FAUCET_URL, EXPLORER_URL, TOKENS, config } from './config';

describe('config', () => {
  it('targets Sepolia only', () => {
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0].id).toBe(11155111);
    expect(config.chains[0].id).toBe(sepolia.id);
  });
  it('has a single injected connector and no EIP-6963 discovery', () => {
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors[0].type).toBe('injected');
    expect(config._internal.mipd).toBeUndefined();
  });
  it('lists PYUSD, USDC and USDG at the spec addresses', () => {
    expect(TOKENS.map((t) => [t.symbol, t.address])).toEqual([
      ['PYUSD', '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9'],
      ['USDC', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
      ['USDG', '0xfBb2A78CceEb415b00300925e464C3E44E6e06b0'],
    ]);
  });
  it('has valid, distinct, checksummed token addresses', () => {
    for (const t of TOKENS) expect(isAddress(t.address, { strict: true })).toBe(true);
    expect(new Set(TOKENS.map((t) => t.address.toLowerCase())).size).toBe(TOKENS.length);
  });
  it('preselects PYUSD', () => {
    expect(DEFAULT_TOKEN.symbol).toBe('PYUSD');
    expect(DEFAULT_TOKEN).toBe(TOKENS[0]);
  });
  it('links to Sepolia Etherscan without a trailing slash', () => {
    expect(EXPLORER_URL).toBe('https://sepolia.etherscan.io');
    expect(EXPLORER_URL.endsWith('/')).toBe(false);
  });
  it('has an ETH faucet link', () => {
    expect(ETH_FAUCET_URL).toMatch(/^https:\/\//);
  });
  it('exports nothing Tempo- or MPP-related', () => {
    for (const name of Object.keys(configModule)) expect(name).not.toMatch(/tempo|mpp|feePayer|wallet_?id/i);
  });
});

describe('config from the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('leaves the optional values undefined when unset', async () => {
    vi.stubEnv('VITE_RPC_URL', '');
    vi.stubEnv('VITE_FACTORY_ADDRESS', '');
    vi.stubEnv('VITE_FACTORY_DEPLOY_BLOCK', '');
    vi.resetModules();
    const fresh = await import('./config');
    expect(fresh.RPC_URL).toBeUndefined();
    expect(fresh.FACTORY_ADDRESS).toBeUndefined();
    expect(fresh.FACTORY_DEPLOY_BLOCK).toBeUndefined();
  });
  it('reads the factory address, deploy block (as a bigint) and RPC URL', async () => {
    vi.stubEnv('VITE_RPC_URL', 'https://rpc.example');
    vi.stubEnv('VITE_FACTORY_ADDRESS', '0x00000000000000000000000000000000000000f0');
    vi.stubEnv('VITE_FACTORY_DEPLOY_BLOCK', '9876543');
    vi.resetModules();
    const fresh = await import('./config');
    expect(fresh.RPC_URL).toBe('https://rpc.example');
    expect(fresh.FACTORY_ADDRESS).toBe('0x00000000000000000000000000000000000000f0');
    expect(fresh.FACTORY_DEPLOY_BLOCK).toBe(9_876_543n);
  });
});
