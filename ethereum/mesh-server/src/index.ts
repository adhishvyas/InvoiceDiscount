import { serve } from '@hono/node-server';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simulateContract, writeContract } from 'viem/actions';
import { sepolia } from 'viem/chains';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { createApp } from './app';
import { readEnv } from './env';

const env = readEnv();
const transport = http(env.rpcUrl);
const account = privateKeyToAccount(env.settlerKey);
const settler = createWalletClient({ account, chain: sepolia, transport });

/** `settleDirect()` from the settler key; a revert in simulation rejects with viem's decoded error. */
async function settle(invoice: Address) {
  const { request } = await simulateContract(settler, { address: invoice, abi: invoiceEscrowAbi, functionName: 'settleDirect', account });
  return writeContract(settler, request);
}

const { app } = createApp({
  allowedOrigin: env.allowedOrigin,
  client: createPublicClient({ chain: sepolia, transport }),
  factory: env.factory,
  meshApi: { baseUrl: env.meshApiUrl, clientId: env.meshClientId, apiKey: env.meshApiKey },
  meshTokens: env.meshTokens,
  networkId: env.networkId,
  chainName: env.chainName,
  webhookSecret: env.webhookSecret,
  settle,
  receiptTimeoutMs: 180_000,
});

serve({ fetch: app.fetch, port: env.port }, ({ port }) =>
  console.log(`mesh-server listening on :${port} (factory ${env.factory}, settler ${account.address})`),
);
