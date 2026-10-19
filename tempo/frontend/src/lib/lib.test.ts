import { describe, expect, it } from 'vitest';
import { decodeRef, encodeRef, refByteLength } from './ref';
import { computeSplit } from './split';
import { fromUnits, toUnits } from './units';
import { percentToBps, validateInvoiceForm, type InvoiceFormInput } from './validation';

const NOW = 1_800_000_000;
const DAY = 86_400;
const ALPHA = '0x20c0000000000000000000000000000000000001';

describe('units', () => {
  it('converts with the given decimals', () => {
    expect(toUnits('100000', 6)).toBe(100_000_000_000n);
    expect(toUnits('1.5', 6)).toBe(1_500_000n);
    expect(toUnits('1.5', 2)).toBe(150n);
    expect(fromUnits(1_500_000n, 6)).toBe('1.5');
  });
  it('round-trips', () => {
    expect(fromUnits(toUnits('0.000001', 6), 6)).toBe('0.000001');
  });
});

describe('ref', () => {
  it('counts bytes, not characters', () => {
    expect(refByteLength('ü')).toBe(2);
    expect(refByteLength('INV-2026-0042')).toBe(13);
  });
  it('accepts a multi-byte reference right at the 32-byte limit', () => {
    const ref = 'INV-' + 'ü'.repeat(14); // 4 + 28 = 32 bytes, 18 characters
    expect(refByteLength(ref)).toBe(32);
    expect(decodeRef(encodeRef(ref))).toBe(ref);
  });
  it('rejects one byte over the limit', () => {
    const ref = 'INV-' + 'ü'.repeat(14) + 'x';
    expect(refByteLength(ref)).toBe(33);
    expect(() => encodeRef(ref)).toThrow();
  });
  it('trims leading and trailing whitespace but keeps inner spaces', () => {
    expect(encodeRef('  INV 1  ')).toBe(encodeRef('INV 1'));
    expect(decodeRef(encodeRef('  INV 1  '))).toBe('INV 1');
    expect(refByteLength('   ')).toBe(0);
  });
  it('pads on the right with zero bytes', () => {
    expect(encodeRef('A')).toBe('0x4100000000000000000000000000000000000000000000000000000000000000');
  });
});

describe('computeSplit', () => {
  it('splits the worked example', () => {
    expect(computeSplit(100_000_000_000n, 1500)).toEqual({ toSeller: 85_000_000_000n, refund: 15_000_000_000n });
    expect(computeSplit(100_000_000_000n, 0)).toEqual({ toSeller: 100_000_000_000n, refund: 0n });
  });
  it('floors the refund and gives the remainder to the seller', () => {
    expect(computeSplit(1001n, 1500)).toEqual({ toSeller: 851n, refund: 150n });
    expect(computeSplit(1n, 9999)).toEqual({ toSeller: 1n, refund: 0n });
  });
  it('allows a 100% discount', () => {
    expect(computeSplit(500n, 10_000)).toEqual({ toSeller: 0n, refund: 500n });
  });
});

describe('percentToBps', () => {
  it('converts percents with up to 2 decimals', () => {
    expect(percentToBps('15')).toBe(1500);
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10_000);
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '-1', '1.234', '1,5', '.5']) expect(percentToBps(bad)).toBeNull();
  });
});

describe('validateInvoiceForm', () => {
  const valid = (): InvoiceFormInput => ({
    invoiceRef: 'INV-2026-0042',
    amount: '100000',
    token: ALPHA,
    decimals: 6,
    dueDate: NOW + 60 * DAY,
    tiers: [
      { cutoff: NOW + 15 * DAY, discountPercent: '15' },
      { cutoff: NOW + 30 * DAY, discountPercent: '10' },
    ],
    payoutAddress: '',
  });
  const check = (patch: Partial<InvoiceFormInput>) => validateInvoiceForm({ ...valid(), ...patch }, NOW);

  it('accepts a valid form, with zero tiers and with a payout address', () => {
    expect(check({}).valid).toBe(true);
    expect(check({ tiers: [] }).valid).toBe(true);
    expect(check({ payoutAddress: '0x000000000000000000000000000000000000dEaD' }).valid).toBe(true);
  });
  it('requires a reference of at most 32 bytes', () => {
    expect(check({ invoiceRef: '   ' }).errors.invoiceRef).toBeDefined();
    expect(check({ invoiceRef: 'x'.repeat(32) }).valid).toBe(true);
    expect(check({ invoiceRef: 'x'.repeat(33) }).errors.invoiceRef).toBeDefined();
  });
  it('requires a positive amount that fits uint128 and the token decimals', () => {
    expect(check({ amount: '' }).errors.amount).toBeDefined();
    expect(check({ amount: '0' }).errors.amount).toBeDefined();
    expect(check({ amount: '0.0000001' }).errors.amount).toBeDefined();
    expect(check({ amount: '-5' }).errors.amount).toBeDefined();
    expect(check({ amount: '0.000001' }).valid).toBe(true);
    expect(check({ amount: '340282366920938463463374607431768.211455' }).valid).toBe(true);
    expect(check({ amount: '340282366920938463463374607431768.211456' }).errors.amount).toBeDefined();
  });
  it('requires a token address', () => {
    expect(check({ token: '' }).errors.token).toBeDefined();
    expect(check({ token: '0x123' }).errors.token).toBeDefined();
  });
  it('requires a due date in the future', () => {
    expect(check({ dueDate: null }).errors.dueDate).toBeDefined();
    expect(check({ dueDate: NOW }).errors.dueDate).toBeDefined();
    expect(check({ dueDate: NOW + 1, tiers: [] }).valid).toBe(true);
  });
  it('allows 10 tiers and rejects 11', () => {
    const tiers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ cutoff: NOW + (i + 1) * DAY, discountPercent: '5' }));
    expect(check({ tiers: tiers(10) }).valid).toBe(true);
    expect(check({ tiers: tiers(11) }).errors.tiers).toBeDefined();
  });
  it('requires strictly ascending cutoffs', () => {
    const t = (cutoff: number) => ({ cutoff, discountPercent: '5' });
    expect(check({ tiers: [t(NOW + DAY), t(NOW + DAY)] }).errors.tierRows[1]?.cutoff).toBeDefined();
    expect(check({ tiers: [t(NOW + 2 * DAY), t(NOW + DAY)] }).errors.tierRows[1]?.cutoff).toBeDefined();
    expect(check({ tiers: [t(0)] }).errors.tierRows[0]?.cutoff).toBeDefined();
  });
  it('allows a cutoff equal to the due date but not after it', () => {
    const due = NOW + 60 * DAY;
    expect(check({ dueDate: due, tiers: [{ cutoff: due, discountPercent: '5' }] }).valid).toBe(true);
    expect(check({ dueDate: due, tiers: [{ cutoff: due + 1, discountPercent: '5' }] }).errors.tierRows[0]?.cutoff).toBeDefined();
  });
  it('allows a 100% discount but not more', () => {
    expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: '100' }] }).valid).toBe(true);
    expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: '100.01' }] }).errors.tierRows[0]?.discount).toBeDefined();
  });
  it('requires a valid payout address when one is given', () => {
    expect(check({ payoutAddress: 'nope' }).errors.payoutAddress).toBeDefined();
    expect(check({ payoutAddress: '   ' }).valid).toBe(true);
  });
});
