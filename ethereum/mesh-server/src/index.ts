import { serve } from '@hono/node-server';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from './app';
import { readEnv } from './env';

const env = readEnv();
const settler = privateKeyToAccount(env.settlerKey);
const app = createApp({ allowedOrigin: env.allowedOrigin });

serve({ fetch: app.fetch, port: env.port }, ({ port }) =>
  console.log(`mesh-server listening on :${port} (factory ${env.factory}, settler ${settler.address})`),
);
