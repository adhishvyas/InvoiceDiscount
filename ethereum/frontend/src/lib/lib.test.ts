import { describe, expect, it } from 'vitest';
import { decodeRef, encodeRef, refByteLength } from './ref';
import { computeSplit } from './split';
import { fromUnits, toUnits } from './units';
import { percentToBps, validateInvoiceForm, type InvoiceFormInput } from './validation';

const NOW = 1_800_000_000;
const DAY = 86_400;
const PYUSD = '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9';

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
  it('converts at 18 decimals', () => {
    expect(toUnits('1', 18)).toBe(1_000_000_000_000_000_000n);
    expect(toUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(toUnits('0.000000000000000001', 18)).toBe(1n);
    expect(toUnits('123456.789', 18)).toBe(123_456_789_000_000_000_000_000n);
    expect(fromUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(fromUnits(1n, 18)).toBe('0.000000000000000001');
    expect(fromUnits(1_000_000_000_000_000_000n, 18)).toBe('1');
    expect(fromUnits(0n, 18)).toBe('0');
  });
  it('round-trips at 18 decimals', () => {
    expect(fromUnits(toUnits('340282366920938463463.374607431768211455', 18), 18)).toBe('340282366920938463463.374607431768211455');
    expect(toUnits(fromUnits(123_456_789_012_345_678n, 18), 18)).toBe(123_456_789_012_345_678n);
  });
  it('does not assume 6 decimals', () => {
    expect(toUnits('1', 6)).not.toBe(toUnits('1', 18));
    expect(fromUnits(1_000_000n, 18)).toBe('0.000000000001');
    expect(fromUnits(1_000_000n, 6)).toBe('1');
  });
  it('handles 0 decimals', () => {
    expect(toUnits('7', 0)).toBe(7n);
    expect(fromUnits(7n, 0)).toBe('7');
  });
  it('formats without trailing zeros or thousands separators', () => {
    expect(fromUnits(1_234_567_890_000n, 6)).toBe('1234567.89');
    expect(fromUnits(100_000_000_000n, 6)).toBe('100000');
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
  it('accepts exactly 32 ASCII bytes', () => {
    expect(decodeRef(encodeRef('x'.repeat(32)))).toBe('x'.repeat(32));
    expect(encodeRef('x'.repeat(32))).toBe(`0x${'78'.repeat(32)}`);
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
    expect(refByteLength('  a b  ')).toBe(3);
  });
  it('measures the trimmed length against the limit', () => {
    expect(decodeRef(encodeRef('  ' + 'x'.repeat(32) + '  '))).toBe('x'.repeat(32));
  });
  it('pads on the right with zero bytes', () => {
    expect(encodeRef('A')).toBe('0x4100000000000000000000000000000000000000000000000000000000000000');
    expect(encodeRef('  A  ')).toBe('0x4100000000000000000000000000000000000000000000000000000000000000');
  });
  it('encodes an empty or blank reference as bytes32(0)', () => {
    expect(encodeRef('')).toBe(`0x${'00'.repeat(32)}`);
    expect(encodeRef('   ')).toBe(`0x${'00'.repeat(32)}`);
  });
  it('decodes without the zero padding', () => {
    expect(decodeRef(`0x${'00'.repeat(32)}`)).toBe('');
    expect(decodeRef('0x4100000000000000000000000000000000000000000000000000000000000000')).toBe('A');
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
  it('always sums to the principal', () => {
    for (const principal of [0n, 1n, 7n, 999n, 1_000_001n, 2n ** 128n - 1n]) {
      for (const bps of [0, 1, 333, 5000, 9999, 10_000]) {
        const { toSeller, refund } = computeSplit(principal, bps);
        expect(toSeller + refund).toBe(principal);
        expect(refund).toBe((principal * BigInt(bps)) / 10_000n);
      }
    }
  });
  it('does not lose precision at uint128 max', () => {
    const max = 2n ** 128n - 1n;
    expect(computeSplit(max, 1).refund).toBe(max / 10_000n);
  });
});

describe('percentToBps', () => {
  it('converts percents with up to 2 decimals', () => {
    expect(percentToBps('15')).toBe(1500);
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('0.5')).toBe(50);
  });
  it('ignores surrounding whitespace and does not cap at 100%', () => {
    expect(percentToBps(' 15 ')).toBe(1500);
    expect(percentToBps('150')).toBe(15_000);
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '-1', '1.234', '1,5', '.5', ' ', '1.', '1e2', '+5', '1 5', '0x10']) {
      expect(percentToBps(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('validateInvoiceForm', () => {
  const valid = (): InvoiceFormInput => ({
    invoiceRef: 'INV-2026-0042',
    amount: '100000',
    token: PYUSD,
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
    const ok = check({});
    expect(ok.valid).toBe(true);
    expect(ok.errors.tierRows).toEqual({});
    expect(check({ tiers: [] }).valid).toBe(true);
    expect(check({ payoutAddress: '0x000000000000000000000000000000000000dEaD' }).valid).toBe(true);
  });
  it('is invalid whenever any field has an error, and valid is false with only a tier-row error', () => {
    expect(check({ invoiceRef: '' }).valid).toBe(false);
    expect(check({ tiers: [{ cutoff: null, discountPercent: '5' }] }).valid).toBe(false);
  });
  it('requires a reference of at most 32 bytes', () => {
    expect(check({ invoiceRef: '   ' }).errors.invoiceRef).toBeDefined();
    expect(check({ invoiceRef: 'x'.repeat(32) }).valid).toBe(true);
    expect(check({ invoiceRef: 'x'.repeat(33) }).errors.invoiceRef).toBeDefined();
    expect(check({ invoiceRef: 'ü'.repeat(17) }).errors.invoiceRef).toBeDefined(); // 17 chars, 34 bytes
    expect(check({ invoiceRef: 'ü'.repeat(16) }).valid).toBe(true); // 16 chars, 32 bytes
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
  it('applies the amount rules at the selected token decimals', () => {
    expect(check({ decimals: 18, amount: '0.000000000000000001' }).valid).toBe(true);
    expect(check({ decimals: 18, amount: '0.0000000000000000001' }).errors.amount).toBeDefined(); // 19 decimals
    expect(check({ decimals: 6, amount: '0.0000001' }).errors.amount).toBeDefined();
    expect(check({ decimals: 18, amount: '340282366920938463463.374607431768211455' }).valid).toBe(true);
    expect(check({ decimals: 18, amount: '340282366920938463463.374607431768211456' }).errors.amount).toBeDefined();
    expect(check({ decimals: 0, amount: '1.5' }).errors.amount).toBeDefined();
    expect(check({ decimals: 0, amount: '5' }).valid).toBe(true);
  });
  it('ignores whitespace around the amount and rejects non-numeric forms', () => {
    expect(check({ amount: ' 10 ' }).valid).toBe(true);
    for (const bad of ['abc', '1e3', '1,000', '1.2.3', '0x10']) {
      expect(check({ amount: bad }).errors.amount, bad).toBeDefined();
    }
  });
  it('requires a token address', () => {
    expect(check({ token: '' }).errors.token).toBeDefined();
    expect(check({ token: '0x123' }).errors.token).toBeDefined();
    expect(check({ token: 'not an address' }).errors.token).toBeDefined();
    expect(check({ token: PYUSD.toLowerCase() }).valid).toBe(true);
    const badChecksum = PYUSD.slice(0, -2) + 'b9'; // flips the case of one hex letter, breaking the EIP-55 checksum
    expect(check({ token: badChecksum }).errors.token).toBeDefined(); // SPEC-QUESTION 4
  });
  it('requires a due date in the future', () => {
    expect(check({ dueDate: null }).errors.dueDate).toBeDefined();
    expect(check({ dueDate: NOW }).errors.dueDate).toBeDefined();
    expect(check({ dueDate: NOW - 1 }).errors.dueDate).toBeDefined();
    expect(check({ dueDate: NOW + 1, tiers: [] }).valid).toBe(true);
  });
  it('allows 10 tiers and rejects 11', () => {
    const tiers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ cutoff: NOW + (i + 1) * DAY, discountPercent: '5' }));
    expect(check({ tiers: tiers(10) }).valid).toBe(true);
    expect(check({ tiers: tiers(11) }).errors.tiers).toBeDefined();
    expect(check({ tiers: tiers(11) }).valid).toBe(false);
  });
  it('requires strictly ascending cutoffs', () => {
    const t = (cutoff: number) => ({ cutoff, discountPercent: '5' });
    expect(check({ tiers: [t(NOW + DAY), t(NOW + DAY)] }).errors.tierRows[1]?.cutoff).toBeDefined();
    expect(check({ tiers: [t(NOW + 2 * DAY), t(NOW + DAY)] }).errors.tierRows[1]?.cutoff).toBeDefined();
    expect(check({ tiers: [t(0)] }).errors.tierRows[0]?.cutoff).toBeDefined();
    expect(check({ tiers: [t(NOW + DAY), t(NOW + 2 * DAY)] }).valid).toBe(true);
  });
  it('compares each cutoff with the previous set cutoff, skipping unset rows', () => {
    const rows = check({
      tiers: [
        { cutoff: NOW + 5 * DAY, discountPercent: '5' },
        { cutoff: null, discountPercent: '5' },
        { cutoff: NOW + 3 * DAY, discountPercent: '5' },
      ],
    }).errors.tierRows;
    expect(rows[1]?.cutoff).toBeDefined();
    expect(rows[2]?.cutoff).toBeDefined();
    expect(rows[0]).toBeUndefined();
  });
  it('requires a set cutoff on every tier row', () => {
    const errors = check({ tiers: [{ cutoff: null, discountPercent: '5' }] }).errors;
    expect(errors.tierRows[0]?.cutoff).toBeDefined();
  });
  it('allows past cutoffs, as the contract does', () => {
    expect(check({ tiers: [{ cutoff: NOW - DAY, discountPercent: '5' }] }).valid).toBe(true);
  });
  it('allows a cutoff equal to the due date but not after it', () => {
    const due = NOW + 60 * DAY;
    expect(check({ dueDate: due, tiers: [{ cutoff: due, discountPercent: '5' }] }).valid).toBe(true);
    expect(check({ dueDate: due, tiers: [{ cutoff: due + 1, discountPercent: '5' }] }).errors.tierRows[0]?.cutoff).toBeDefined();
  });
  it('allows a 100% discount but not more', () => {
    expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: '100' }] }).valid).toBe(true);
    expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: '100.01' }] }).errors.tierRows[0]?.discount).toBeDefined();
    expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: '150' }] }).errors.tierRows[0]?.discount).toBeDefined();
  });
  it('rejects an unparseable discount percent', () => {
    for (const bad of ['', 'abc', '-5', '1.234']) {
      expect(check({ tiers: [{ cutoff: NOW + DAY, discountPercent: bad }] }).errors.tierRows[0]?.discount, bad).toBeDefined();
    }
  });
  it('reports errors only on the offending rows, keyed by index', () => {
    const rows = check({
      tiers: [
        { cutoff: NOW + DAY, discountPercent: '5' },
        { cutoff: NOW + 2 * DAY, discountPercent: 'x' },
        { cutoff: NOW + 3 * DAY, discountPercent: '5' },
      ],
    }).errors.tierRows;
    expect(Object.keys(rows)).toEqual(['1']);
  });
  it('requires a valid payout address when one is given', () => {
    expect(check({ payoutAddress: 'nope' }).errors.payoutAddress).toBeDefined();
    expect(check({ payoutAddress: '0x123' }).errors.payoutAddress).toBeDefined();
    expect(check({ payoutAddress: '   ' }).valid).toBe(true);
  });
  it('omits the keys of valid fields', () => {
    const { errors } = check({});
    expect(errors.invoiceRef).toBeUndefined();
    expect(errors.amount).toBeUndefined();
    expect(errors.token).toBeUndefined();
    expect(errors.dueDate).toBeUndefined();
    expect(errors.tiers).toBeUndefined();
    expect(errors.payoutAddress).toBeUndefined();
  });
});
