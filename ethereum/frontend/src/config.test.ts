import { isAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configModule from './config';
import { DEFAULT_TOKEN, ETH_FAUCET_URL, EXPLORER_URL, MESH_TOKENS, TOKENS, config } from './config';

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
  it('lists PYUSD, USDC and USDG at the spec addresses, and ETH at the zero address', () => {
    const by = (sym: string) => TOKENS.find((t) => t.symbol === sym)?.address;
    expect(by('PYUSD')).toBe('0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9');
    expect(by('USDC')).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(by('USDG')).toBe('0xfBb2A78CceEb415b00300925e464C3E44E6e06b0');
    expect(by('ETH')).toBe('0x0000000000000000000000000000000000000000');
    expect(TOKENS).toHaveLength(4);
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
  it('offers Pay with Mesh for PYUSD, USDG and ETH only, a subset of TOKENS with the same addresses', () => {
    expect(MESH_TOKENS.map((t) => t.symbol).sort()).toEqual(['ETH', 'PYUSD', 'USDG']);
    expect(MESH_TOKENS.find((t) => t.symbol === 'ETH')?.address).toBe('0x0000000000000000000000000000000000000000');
    for (const m of MESH_TOKENS) expect(TOKENS).toContainEqual({ symbol: m.symbol, address: m.address });
    expect(MESH_TOKENS.map((t) => t.symbol)).not.toContain('USDC');
    const usdc = TOKENS.find((t) => t.symbol === 'USDC')!;
    expect(MESH_TOKENS.map((t) => t.address.toLowerCase())).not.toContain(usdc.address.toLowerCase());
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
  it('leaves MESH_SERVER_URL undefined when unset, and reads it when set', async () => {
    // SPEC-QUESTION 6
    vi.stubEnv('VITE_MESH_SERVER_URL', '');
    vi.resetModules();
    expect((await import('./config')).MESH_SERVER_URL).toBeUndefined();
    vi.stubEnv('VITE_MESH_SERVER_URL', 'http://localhost:8788');
    vi.resetModules();
    expect((await import('./config')).MESH_SERVER_URL).toBe('http://localhost:8788');
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
