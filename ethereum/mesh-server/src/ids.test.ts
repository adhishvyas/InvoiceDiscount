import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { decodeTransactionId, encodeTransactionId, newSessionId } from './ids';

const INVOICE = '0x19d0ffbca47bfdcfe83ef9ebc6220860175b62ab';
const ID = '0123456789abcdef';

describe('newSessionId', () => {
  it('is 16 lowercase hex characters', () => {
    for (let i = 0; i < 50; i++) expect(newSessionId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 200 }, newSessionId)).size).toBe(200);
  });
});

describe('encodeTransactionId', () => {
  it('is the lowercase invoice, a dash and the id: 59 characters', () => {
    const tx = encodeTransactionId(INVOICE, ID);
    expect(tx).toBe(`${INVOICE}-${ID}`);
    expect(tx).toHaveLength(59);
  });

  it('lowercases a checksummed or mixed-case address', () => {
    expect(encodeTransactionId(getAddress(INVOICE), ID)).toBe(`${INVOICE}-${ID}`);
    expect(encodeTransactionId('0x19D0FFBCA47BFDCFE83EF9EBC6220860175B62AB', ID)).toBe(`${INVOICE}-${ID}`);
  });
});

describe('decodeTransactionId', () => {
  it('round-trips with the invoice checksummed', () => {
    expect(decodeTransactionId(encodeTransactionId(INVOICE, ID))).toEqual({ invoice: getAddress(INVOICE), id: ID });
  });

  it('round-trips a generated id', () => {
    const id = newSessionId();
    expect(decodeTransactionId(encodeTransactionId(getAddress(INVOICE), id))).toEqual({ invoice: getAddress(INVOICE), id });
  });

  it('accepts hex in any case and returns the id in lowercase', () => {
    const mixed = `0x19D0ffbca47bfdcfe83ef9ebc6220860175b62AB-0123456789ABCDEF`;
    expect(decodeTransactionId(mixed)).toEqual({ invoice: getAddress(INVOICE), id: ID });
  });

  it.each([
    ['empty', ''],
    ['no separator', `${INVOICE}${ID}`],
    ['id one character short', `${INVOICE}-${ID.slice(1)}`],
    ['id one character long', `${INVOICE}-${ID}0`],
    ['address one character short', `${INVOICE.slice(0, -1)}-${ID}`],
    ['address one character long', `${INVOICE}0-${ID}`],
    ['no 0x prefix', `${INVOICE.slice(2)}-${ID}`],
    ['non-hex in the address', `0x19d0ffbca47bfdcfe83ef9ebc6220860175b62ag-${ID}`],
    ['non-hex in the id', `${INVOICE}-0123456789abcdeg`],
    ['underscore separator', `${INVOICE}_${ID}`],
    ['double dash', `${INVOICE}--${ID}`],
    ['trailing text', `${INVOICE}-${ID}-x`],
    ['leading text', `x${INVOICE}-${ID}`],
    ['leading space', ` ${INVOICE}-${ID}`],
    ['trailing newline', `${INVOICE}-${ID}\n`],
    ['only the address', INVOICE],
    ['missing address', `-${ID}`],
    ['missing id', `${INVOICE}-`],
  ])('rejects %s', (_name, value) => {
    expect(decodeTransactionId(value)).toBeUndefined();
  });
});
