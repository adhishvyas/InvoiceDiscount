import { tempoModerato } from 'viem/chains';
import { createConfig, http } from 'wagmi';
import { injected, tempoWallet } from 'wagmi/connectors';

export const SPONSOR_URL = 'https://sponsor.moderato.tempo.xyz';
export const TEMPO_WALLET_ID = 'xyz.tempo';
export const EXPLORER_URL = 'https://explore.testnet.tempo.xyz';

export const config = createConfig({
  chains: [tempoModerato],
  connectors: [tempoWallet({ feePayer: SPONSOR_URL }), injected()],
  multiInjectedProviderDiscovery: false,
  transports: { [tempoModerato.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
}

/** Moderato test stablecoins; all TIP-20 tokens use 6 decimals, but callers should still read `decimals()`. */
export const TOKENS: readonly TokenInfo[] = [
  { symbol: 'AlphaUSD', address: '0x20c0000000000000000000000000000000000001' },
  { symbol: 'BetaUSD', address: '0x20c0000000000000000000000000000000000002' },
  { symbol: 'ThetaUSD', address: '0x20c0000000000000000000000000000000000003' },
  { symbol: 'pathUSD', address: '0x20c0000000000000000000000000000000000000' },
  { symbol: 'OUSD', address: '0x20c0000000000000000000006a37da5c996874be' },
];

export const DEFAULT_TOKEN = TOKENS[0];

export const FACTORY_ADDRESS = (import.meta.env.VITE_FACTORY_ADDRESS || undefined) as `0x${string}` | undefined;
export const FACTORY_DEPLOY_BLOCK = import.meta.env.VITE_FACTORY_DEPLOY_BLOCK
  ? BigInt(import.meta.env.VITE_FACTORY_DEPLOY_BLOCK)
  : undefined;
