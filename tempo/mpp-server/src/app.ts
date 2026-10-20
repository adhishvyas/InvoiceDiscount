import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface AppConfig {
  allowedOrigin: string;
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
  return app;
}
