import { sepolia } from 'viem/chains';
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

/** Sepolia Etherscan; links are `${EXPLORER_URL}/tx/<hash>` and `${EXPLORER_URL}/address/<address>`. */
export const EXPLORER_URL = 'https://sepolia.etherscan.io';
/** Where to get Sepolia ETH for gas; shown on the connect screen. */
export const ETH_FAUCET_URL = 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia';

/** Must accept a 10,000-block `eth_getLogs` range (spec §5.1); unset falls back to viem's default Sepolia RPC. */
export const RPC_URL = (import.meta.env.VITE_RPC_URL || undefined) as string | undefined;

/** wagmi config: Sepolia only, one injected connector (no EIP-6963 discovery, so a single "Connect wallet" button). */
export const config = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  multiInjectedProviderDiscovery: false,
  transports: { [sepolia.id]: http(RPC_URL) },
});

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}

/** A token offered in the create form. */
export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
}

/** Sepolia test stablecoins (verification notes items 1a–1c); all use 6 decimals, but callers should still read `decimals()`. */
export const TOKENS: readonly TokenInfo[] = [
  { symbol: 'PYUSD', address: '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9' },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  { symbol: 'USDG', address: '0xfBb2A78CceEb415b00300925e464C3E44E6e06b0' },
];

/** PYUSD, preselected in the create form. */
export const DEFAULT_TOKEN = TOKENS[0];

/** `VITE_FACTORY_ADDRESS`; undefined when unset. */
export const FACTORY_ADDRESS = (import.meta.env.VITE_FACTORY_ADDRESS || undefined) as `0x${string}` | undefined;
/** `VITE_FACTORY_DEPLOY_BLOCK`; log scans start here. Undefined when unset. */
export const FACTORY_DEPLOY_BLOCK = import.meta.env.VITE_FACTORY_DEPLOY_BLOCK
  ? BigInt(import.meta.env.VITE_FACTORY_DEPLOY_BLOCK)
  : undefined;

/** `VITE_MESH_SERVER_URL`, mesh-server's origin; undefined when unset, which hides Pay with Mesh. */
export const MESH_SERVER_URL = (import.meta.env.VITE_MESH_SERVER_URL || undefined) as string | undefined;

/** The tokens Pay with Mesh is offered for (Mesh spec §6.1): PYUSD and USDG, same addresses as in `TOKENS`. */
export const MESH_TOKENS: readonly TokenInfo[] = [
  { symbol: 'PYUSD', address: '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9' },
  { symbol: 'USDG', address: '0xfBb2A78CceEb415b00300925e464C3E44E6e06b0' },
];
