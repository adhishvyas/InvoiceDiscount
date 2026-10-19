import { describe, expect, it } from 'vitest';
import { TEMPO_WALLET_ID, config } from './config';

describe('config', () => {
  it('registers the Tempo Wallet connector under its id, plus an injected fallback', () => {
    const ids = config.connectors.map((c) => c.id);
    expect(ids).toContain(TEMPO_WALLET_ID);
    expect(ids).toHaveLength(2);
  });
  it('targets Moderato', () => {
    expect(config.chains[0].id).toBe(42431);
  });
});
