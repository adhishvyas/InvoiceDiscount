import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { CLONE, CLONE_B, newHash } from './fakeChain';
import { SessionStore, sessionView, type Session } from './sessions';

const init = (n: number, invoice: Address = CLONE): Omit<Session, 'state'> => ({
  id: `id${n}`,
  invoice,
  transactionId: `${invoice.toLowerCase()}-${n}`,
  amount: 90_000_000n,
  discountBps: 1000,
  symbol: 'PYUSD',
  expiresAt: 1_800_000_600n,
});

describe('SessionStore', () => {
  it('creates a session awaiting transfer, with the invoice checksummed', () => {
    const store = new SessionStore();
    const s = store.create(init(1));
    expect(s.state).toBe('awaiting-transfer');
    expect(s.invoice).toBe(getAddress(CLONE));
    expect(s.amount).toBe(90_000_000n);
    expect(store.get('id1')).toEqual(s);
  });

  it('looks sessions up by id and by transactionId', () => {
    const store = new SessionStore();
    const s = store.create(init(1));
    expect(store.get('id1')?.id).toBe('id1');
    expect(store.byTransactionId(s.transactionId)?.id).toBe('id1');
    expect(store.get('nope')).toBeUndefined();
    expect(store.byTransactionId('nope')).toBeUndefined();
  });

  it('throws on a duplicate id or transactionId', () => {
    const store = new SessionStore();
    store.create(init(1));
    expect(() => store.create(init(1))).toThrow();
    expect(() => store.create({ ...init(2), id: 'id1' })).toThrow();
    expect(() => store.create({ ...init(2), transactionId: init(1).transactionId })).toThrow();
  });

  it('lists an invoice sessions newest first, matching the address in any case', () => {
    const store = new SessionStore();
    store.create(init(1));
    store.create(init(2, CLONE_B));
    store.create(init(3));
    store.create(init(4));
    expect(store.forInvoice(CLONE).map((s) => s.id)).toEqual(['id4', 'id3', 'id1']);
    expect(store.forInvoice(getAddress(CLONE)).map((s) => s.id)).toEqual(['id4', 'id3', 'id1']);
    expect(store.forInvoice(CLONE_B).map((s) => s.id)).toEqual(['id2']);
    expect(store.forInvoice('0x00000000000000000000000000000000000000ee')).toEqual([]);
  });

  it('merges a patch and returns the updated session', () => {
    const store = new SessionStore();
    store.create(init(1));
    const settleTx = newHash();
    const updated = store.update('id1', { state: 'settled', settleTx });
    expect(updated.state).toBe('settled');
    expect(updated.settleTx).toBe(settleTx);
    expect(updated.amount).toBe(90_000_000n);
    expect(store.get('id1')).toEqual(updated);
    expect(store.forInvoice(CLONE)[0].state).toBe('settled');
    expect(store.byTransactionId(updated.transactionId)?.state).toBe('settled');
  });

  it('throws when updating an unknown id', () => {
    const store = new SessionStore();
    store.create(init(1));
    expect(store.update('id1', { state: 'failed' }).state).toBe('failed');
    expect(() => store.update('nope', { state: 'failed' })).toThrow();
  });
});

describe('sessionView', () => {
  it('turns amount into a decimal string, keeps expiresAt a number and drops transactionId', () => {
    const view = sessionView(new SessionStore().create({ ...init(1), amount: 10n ** 30n + 1n }));
    expect(view).toEqual({
      id: 'id1',
      invoice: getAddress(CLONE),
      state: 'awaiting-transfer',
      amount: '1000000000000000000000000000001',
      discountBps: 1000,
      expiresAt: 1_800_000_600,
    });
    expect(view).not.toHaveProperty('transactionId');
    expect(view).not.toHaveProperty('symbol');
  });

  it('omits absent optional fields and includes present ones', () => {
    const store = new SessionStore();
    store.create(init(1));
    const bare = sessionView(store.get('id1')!);
    for (const key of ['transferTx', 'settleTx', 'reason', 'payer']) expect(bare).not.toHaveProperty(key);

    const transferTx = newHash();
    const settleTx = newHash();
    const full = sessionView(
      store.update('id1', {
        state: 'needs-attention',
        transferTx,
        settleTx,
        reason: 'insufficient balance: 1 < 2',
        payer: { provider: 'metamask', sourceAddress: '0xaa' },
      }),
    );
    expect(full).toMatchObject({
      state: 'needs-attention',
      transferTx,
      settleTx,
      reason: 'insufficient balance: 1 < 2',
      payer: { provider: 'metamask', sourceAddress: '0xaa' },
    });
  });

  it('shows a recreated session with a zero amount and expiry', () => {
    const view = sessionView(new SessionStore().create({ ...init(1), amount: 0n, expiresAt: 0n, discountBps: 0, symbol: '' }));
    expect(view.amount).toBe('0');
    expect(view.expiresAt).toBe(0);
  });
});
