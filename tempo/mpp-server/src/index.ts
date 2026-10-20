import { serve } from '@hono/node-server';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { createApp } from './app';
import { readEnv } from './env';

const env = readEnv();
const transport = http(env.rpcUrl);
const settler = privateKeyToAccount(env.settlerKey);
const app = createApp({
  allowedOrigin: env.allowedOrigin,
  pay: {
    client: createPublicClient({ chain: tempoModerato, transport }),
    settler: createWalletClient({ account: settler, chain: tempoModerato, transport }),
    factory: env.factory,
    secretKey: env.secretKey,
  },
});

serve({ fetch: app.fetch, port: env.port }, ({ port }) => console.log(`mpp-server listening on :${port} (factory ${env.factory}, settler ${settler.address})`));
