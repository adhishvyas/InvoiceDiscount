import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';

export interface Env {
  meshClientId: string;
  meshApiKey: string;
  meshApiUrl: string;
  webhookSecret: string;
  networkId: string;
  chainName: string;
  /** Mesh-supported token address → the symbol Mesh uses for it. */
  meshTokens: Record<Address, string>;
  settlerKey: Hex;
  factory: Address;
  rpcUrl: string;
  allowedOrigin: string;
  port: number;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
};

/** `SYMBOL:0xaddr,SYMBOL:0xaddr` → `{ [address]: symbol }`. */
function parseTokens(value: string): Record<Address, string> {
  const tokens: Record<Address, string> = {};
  for (const entry of value.split(',')) {
    const [symbol, address] = entry.trim().split(':');
    if (!symbol || !address || !isAddress(address)) throw new Error(`MESH_TOKENS entry "${entry}" is not SYMBOL:address`);
    tokens[getAddress(address)] = symbol;
  }
  return tokens;
}

/** Reads and checks the env once at startup. */
export function readEnv(): Env {
  const settlerKey = required('SETTLER_PRIVATE_KEY');
  const factory = required('FACTORY_ADDRESS');
  if (!isHex(settlerKey) || settlerKey.length !== 66) throw new Error('SETTLER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  if (!isAddress(factory)) throw new Error('FACTORY_ADDRESS is not an address');
  return {
    meshClientId: required('MESH_CLIENT_ID'),
    meshApiKey: required('MESH_API_KEY'),
    meshApiUrl: process.env.MESH_API_URL || 'https://sandbox-integration-api.meshconnect.com',
    webhookSecret: required('MESH_WEBHOOK_SECRET'),
    networkId: required('MESH_NETWORK_ID'),
    chainName: required('MESH_CHAIN_NAME'),
    meshTokens: parseTokens(required('MESH_TOKENS')),
    settlerKey,
    factory: getAddress(factory),
    rpcUrl: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com',
    allowedOrigin: required('ALLOWED_ORIGIN'),
    port: Number(process.env.PORT || 8788),
  };
}
