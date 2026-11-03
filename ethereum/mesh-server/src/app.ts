import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface AppConfig {
  allowedOrigin: string;
}

/** The HTTP app, without a listener, so tests can call `app.request()`. */
export function createApp(config: AppConfig) {
  const app = new Hono();
  app.use('*', cors({ origin: config.allowedOrigin }));
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
