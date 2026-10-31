import { describe, expect, it } from 'vitest';
import { upcomingCutoff } from './cutoff';

const NOW = 1_000_000n;
const t = (...cutoffs: bigint[]) => cutoffs.map((cutoff) => ({ cutoff }));

describe('upcomingCutoff', () => {
  it('matches the documented example', () => {
    expect(upcomingCutoff(t(1_000n), 800n)).toBe(1_000n);
    expect(upcomingCutoff(t(1_000n), 700n)).toBeUndefined();
  });
  it('is undefined with no tiers', () => {
    expect(upcomingCutoff([], NOW)).toBeUndefined();
  });
  it('returns a cutoff inside the default 300 s window', () => {
    expect(upcomingCutoff(t(NOW + 120n), NOW)).toBe(NOW + 120n);
    expect(upcomingCutoff(t(NOW + 299n), NOW)).toBe(NOW + 299n);
    expect(upcomingCutoff(t(NOW + 1n), NOW)).toBe(NOW + 1n);
  });
  it('treats a cutoff exactly at the window edge as outside', () => {
    expect(upcomingCutoff(t(NOW + 300n), NOW)).toBeUndefined();
  });
  it('is undefined for a cutoff beyond the window', () => {
    expect(upcomingCutoff(t(NOW + 301n), NOW)).toBeUndefined();
    expect(upcomingCutoff(t(NOW + 86_400n), NOW)).toBeUndefined();
  });
  it('treats a cutoff equal to now as already passed', () => {
    expect(upcomingCutoff(t(NOW), NOW)).toBeUndefined();
  });
  it('ignores past cutoffs, including just-passed ones', () => {
    expect(upcomingCutoff(t(NOW - 1n, NOW - 10_000n, 0n), NOW)).toBeUndefined();
  });
  it('picks the next future cutoff past earlier ones', () => {
    expect(upcomingCutoff(t(NOW - 5n, NOW, NOW + 60n, NOW + 5_000n), NOW)).toBe(NOW + 60n);
  });
  it('returns the smallest in-window cutoff when tiers are unsorted', () => {
    expect(upcomingCutoff(t(NOW + 200n, NOW + 50n, NOW + 100n), NOW)).toBe(NOW + 50n);
    expect(upcomingCutoff(t(NOW + 10_000n, NOW - 10n, NOW + 250n), NOW)).toBe(NOW + 250n);
  });
  it('is undefined when only the next cutoff is outside the window, even if later ones are further', () => {
    expect(upcomingCutoff(t(NOW + 900n, NOW + 300n, NOW + 1_000n), NOW)).toBeUndefined();
  });
  it('honours a custom window', () => {
    expect(upcomingCutoff(t(NOW + 3_599n), NOW, 3_600n)).toBe(NOW + 3_599n);
    expect(upcomingCutoff(t(NOW + 3_600n), NOW, 3_600n)).toBeUndefined();
    expect(upcomingCutoff(t(NOW + 100n), NOW, 60n)).toBeUndefined();
    expect(upcomingCutoff(t(NOW + 59n), NOW, 60n)).toBe(NOW + 59n);
  });
  it('is always undefined with a zero window', () => {
    expect(upcomingCutoff(t(NOW + 1n, NOW), NOW, 0n)).toBeUndefined();
  });
  it('handles duplicate cutoffs', () => {
    expect(upcomingCutoff(t(NOW + 10n, NOW + 10n), NOW)).toBe(NOW + 10n);
  });
});
