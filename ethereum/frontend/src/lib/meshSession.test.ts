import { describe, expect, it } from 'vitest';
import { isFinalMeshState, type SessionState } from './meshSession';

describe('isFinalMeshState', () => {
  const cases: [SessionState, boolean][] = [
    ['awaiting-transfer', false],
    ['pending', false],
    ['succeeded', false],
    ['settled', true],
    ['failed', true],
    ['needs-attention', true],
  ];
  it.each(cases)('%s -> %s', (state, final) => {
    expect(isFinalMeshState(state)).toBe(final);
  });
});
