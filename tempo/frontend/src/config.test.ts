import { describe, expect, it, vi } from 'vitest';
import { TEMPO_WALLET_ID, config } from './config';

describe('config', () => {
  it('registers the Tempo Wallet connector under its id, plus an injected fallback', () => {
    const ids = config.connectors.map((c) => c.id);
    expect(ids).toContain(TEMPO_WALLET_ID);
    expect(ids).toHaveLength(2);
  });
  it('leaves the global fetch alone, so a 402 is only paid through our confirm step', async () => {
    vi.resetModules();
    const fetch = globalThis.fetch;
    const fresh = await import('./config');
    await fresh.config.connectors.find((c) => c.id === TEMPO_WALLET_ID)!.getProvider();
    expect(globalThis.fetch).toBe(fetch);
  });
  it('targets Moderato', () => {
    expect(config.chains[0].id).toBe(42431);
  });
});
