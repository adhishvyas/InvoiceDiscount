import { serve } from '@hono/node-server';
import { createApp } from './app';
import { readEnv } from './env';

const env = readEnv();
const app = createApp({ allowedOrigin: env.allowedOrigin });

serve({ fetch: app.fetch, port: env.port }, ({ port }) => console.log(`mpp-server listening on :${port}`));
