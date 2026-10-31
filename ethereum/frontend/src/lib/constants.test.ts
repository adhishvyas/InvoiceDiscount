import { describe, expect, it } from 'vitest';
import { LOG_PAGE_SIZE } from './logs';
import { REF_MAX_BYTES } from './ref';
import { BPS_DENOMINATOR } from './split';
import { STATUS_LABEL, Status } from './status';
import { MAX_TIERS } from './validation';

// Pure data written in full at the interface tag; these are expected to pass against the stubs.
describe('constants', () => {
  it('LOG_PAGE_SIZE is 10,000 blocks (verification notes item 3c)', () => {
    expect(LOG_PAGE_SIZE).toBe(10_000n);
  });
  it('MAX_TIERS is the contract limit of 10', () => {
    expect(MAX_TIERS).toBe(10);
  });
  it('REF_MAX_BYTES is 32', () => {
    expect(REF_MAX_BYTES).toBe(32);
  });
  it('BPS_DENOMINATOR is 10,000', () => {
    expect(BPS_DENOMINATOR).toBe(10_000n);
  });
  it('Status mirrors the contract enum order and has a label for each', () => {
    expect(Status).toEqual({ Active: 0, Funded: 1, Paid: 2, Cancelled: 3 });
    expect(STATUS_LABEL).toEqual({ 0: 'Active', 1: 'Funded', 2: 'Paid', 3: 'Cancelled' });
  });
});
