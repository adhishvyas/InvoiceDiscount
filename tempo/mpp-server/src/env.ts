import { isAddress, isHex, type Address, type Hex } from 'viem';

export interface Env {
  secretKey: string;
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

/** Reads and checks the env once at startup. */
export function readEnv(): Env {
  const settlerKey = required('SETTLER_PRIVATE_KEY');
  const factory = required('FACTORY_ADDRESS');
  if (!isHex(settlerKey) || settlerKey.length !== 66) throw new Error('SETTLER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  if (!isAddress(factory)) throw new Error('FACTORY_ADDRESS is not an address');
  return {
    secretKey: required('MPP_SECRET_KEY'),
    settlerKey,
    factory,
    rpcUrl: process.env.TEMPO_RPC_URL || 'https://rpc.moderato.tempo.xyz',
    allowedOrigin: required('ALLOWED_ORIGIN'),
    port: Number(process.env.PORT || 8787),
  };
}
