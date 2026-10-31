import { BaseError, InsufficientFundsError } from 'viem';
import { describe, expect, it } from 'vitest';
import { friendlyError } from './errors';

const GAS = 'You need Sepolia ETH to pay gas';

describe('friendlyError', () => {
  it("explains viem's InsufficientFundsError (whose own message does not say 'insufficient funds')", () => {
    expect(friendlyError(new InsufficientFundsError({ cause: new Error('boom') }))).toBe(GAS);
  });
  it('finds an InsufficientFundsError nested in a viem cause chain', () => {
    const inner = new InsufficientFundsError({ cause: new Error('rpc') });
    const wrapped = new BaseError('Execution reverted for an unknown reason.', { cause: inner });
    const outer = new BaseError('The contract function "fund" reverted.', { cause: wrapped });
    expect(friendlyError(outer)).toBe(GAS);
  });
  it('finds an InsufficientFundsError under a plain Error cause', () => {
    const err = new Error('write failed', { cause: new InsufficientFundsError({ cause: new Error('x') }) });
    expect(friendlyError(err)).toBe(GAS);
  });
  it("matches an 'insufficient funds' message, case-insensitively", () => {
    expect(friendlyError(new Error('insufficient funds for gas * price + value'))).toBe(GAS);
    expect(friendlyError(new Error('Insufficient Funds'))).toBe(GAS);
    expect(friendlyError(new Error('RPC: INSUFFICIENT FUNDS for transfer'))).toBe(GAS);
  });
  it("matches an 'insufficient funds' message anywhere in the cause chain", () => {
    const err = new Error('Internal JSON-RPC error.', { cause: new Error('nested', { cause: new Error('insufficient funds') }) });
    expect(friendlyError(err)).toBe(GAS);
  });
  it('passes through the shortMessage of other viem errors', () => {
    const err = new BaseError('User rejected the request.', { details: 'long details that should not be shown' });
    expect(friendlyError(err)).toBe('User rejected the request.');
  });
  it('passes through the message of a plain Error', () => {
    expect(friendlyError(new Error('Something broke'))).toBe('Something broke');
  });
  it('prefers shortMessage over message when both exist', () => {
    const err = Object.assign(new Error('long message\nwith details'), { shortMessage: 'short one' });
    expect(friendlyError(err)).toBe('short one');
  });
  it('falls back to message when shortMessage is absent', () => {
    expect(friendlyError(new TypeError('bad type'))).toBe('bad type');
  });
  it('stringifies non-Error values', () => {
    expect(friendlyError('plain string')).toBe('plain string');
    expect(friendlyError(42)).toBe('42');
    expect(friendlyError(undefined)).toBe('undefined');
    expect(friendlyError(null)).toBe('null');
  });
  it('treats a bare string as a non-Error, even with the phrase', () => {
    expect(friendlyError('insufficient funds')).toBe('insufficient funds'); // SPEC-QUESTION 3
  });
});
