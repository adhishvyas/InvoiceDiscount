import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { payHandler, type PayConfig } from './pay';

export interface AppConfig {
  allowedOrigin: string;
  pay: PayConfig;
}

/** The HTTP app, without a listener, so tests can call `app.request()`. */
export function createApp(config: AppConfig) {
  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: config.allowedOrigin,
      allowHeaders: ['Authorization', 'Accept-Payment'],
      exposeHeaders: ['WWW-Authenticate', 'Payment-Receipt'],
    }),
  );
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/invoices/:address/pay', payHandler(config.pay));
  return app;
}
