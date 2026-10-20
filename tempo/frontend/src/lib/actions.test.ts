import { describe, expect, it } from 'vitest';
import { visibleActions, type ActionContext } from './actions';
import { Status, type StatusValue } from './status';

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b2';
const STRANGER = '0x00000000000000000000000000000000000000c3';
const ZERO = '0x0000000000000000000000000000000000000000';
const DUE = 1_000n;

const DUE_NOW = 900n;

const ctx = (patch: Partial<ActionContext>): ActionContext => ({
  account: SELLER,
  walletMode: 'tempo',
  mppEnabled: true,
  seller: SELLER,
  buyer: ZERO,
  status: Status.Active,
  dueDate: DUE,
  now: DUE - 1n,
  cloneBalance: 0n,
  dueNow: DUE_NOW,
  ...patch,
});

const NONE = { fund: false, trigger: false, cancel: false, payNow: false, finishSettlement: false, acceptAndSettle: false };
/** Only the lifecycle actions, for the cases that predate MPP pay-now. */
const lifecycle = ({ fund, trigger, cancel }: ReturnType<typeof visibleActions>) => ({ fund, trigger, cancel });

describe('visibleActions', () => {
  it('shows nothing when disconnected', () => {
    for (const status of [0, 1, 2, 3] as StatusValue[]) {
      for (const cloneBalance of [0n, DUE_NOW]) {
        expect(
          visibleActions(ctx({ account: undefined, walletMode: 'disconnected', status, buyer: status ? BUYER : ZERO, cloneBalance })),
        ).toEqual(NONE);
      }
    }
  });

  describe('Active (unfunded)', () => {
    it('lets the seller cancel, before and after the due date, but not fund or trigger', () => {
      for (const now of [DUE - 1n, DUE, DUE + 1n]) {
        expect(lifecycle(visibleActions(ctx({ now })))).toEqual({ fund: false, trigger: false, cancel: true });
      }
    });
    it('lets any other connected account fund, and nothing else', () => {
      expect(lifecycle(visibleActions(ctx({ account: STRANGER })))).toEqual({ fund: true, trigger: false, cancel: false });
      expect(lifecycle(visibleActions(ctx({ account: STRANGER, now: DUE + 1n })))).toEqual({ fund: true, trigger: false, cancel: false });
    });
  });

  describe('Funded', () => {
    const funded = (patch: Partial<ActionContext>) => ctx({ status: Status.Funded, buyer: BUYER, ...patch });
    it('lets the seller trigger and cancel at any time, but not fund', () => {
      for (const now of [DUE - 1n, DUE + 1n]) {
        expect(lifecycle(visibleActions(funded({ now })))).toEqual({ fund: false, trigger: true, cancel: true });
      }
    });
    it('lets the buyer trigger always, and cancel only strictly after the due date', () => {
      expect(lifecycle(visibleActions(funded({ account: BUYER, now: DUE - 1n })))).toEqual({ fund: false, trigger: true, cancel: false });
      expect(lifecycle(visibleActions(funded({ account: BUYER, now: DUE })))).toEqual({ fund: false, trigger: true, cancel: false });
      expect(lifecycle(visibleActions(funded({ account: BUYER, now: DUE + 1n })))).toEqual({ fund: false, trigger: true, cancel: true });
    });
    it('shows a third party nothing', () => {
      for (const now of [DUE - 1n, DUE + 1n]) {
        expect(lifecycle(visibleActions(funded({ account: STRANGER, now })))).toEqual({ fund: false, trigger: false, cancel: false });
      }
    });
  });

  it('shows nothing once Paid or Cancelled, for anyone', () => {
    for (const status of [Status.Paid, Status.Cancelled]) {
      for (const account of [SELLER, BUYER, STRANGER]) {
        for (const now of [DUE - 1n, DUE + 1n]) {
          expect(visibleActions(ctx({ status, buyer: BUYER, account, now, cloneBalance: DUE_NOW }))).toEqual(NONE);
        }
      }
    }
  });

  it('compares addresses case-insensitively', () => {
    expect(visibleActions(ctx({ account: SELLER.toUpperCase().replace('0X', '0x') })).cancel).toBe(true);
  });

  describe('Pay now via MPP', () => {
    it('is offered to a connected Tempo Wallet that is not the seller, while Active', () => {
      expect(visibleActions(ctx({ account: STRANGER })).payNow).toBe(true);
    });
    it('is not offered to the seller, an injected wallet, a disconnected viewer, or without a server', () => {
      expect(visibleActions(ctx({})).payNow).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, walletMode: 'injected' })).payNow).toBe(false);
      expect(visibleActions(ctx({ account: undefined, walletMode: 'disconnected' })).payNow).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, mppEnabled: false })).payNow).toBe(false);
    });
    it('is not offered once Funded, Paid or Cancelled', () => {
      for (const status of [Status.Funded, Status.Paid, Status.Cancelled]) {
        expect(visibleActions(ctx({ account: STRANGER, status, buyer: BUYER })).payNow).toBe(false);
      }
    });
    it('is not offered when the invoice already holds the amount due, so nobody pays twice', () => {
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: DUE_NOW })).payNow).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: DUE_NOW - 1n })).payNow).toBe(true);
    });
  });

  describe('Finish settlement', () => {
    it('is offered to anyone connected once the balance covers the amount due, while Active', () => {
      for (const account of [SELLER, STRANGER]) {
        for (const walletMode of ['tempo', 'injected'] as const) {
          expect(visibleActions(ctx({ account, walletMode, cloneBalance: DUE_NOW })).finishSettlement).toBe(true);
          expect(visibleActions(ctx({ account, walletMode, cloneBalance: DUE_NOW + 1n })).finishSettlement).toBe(true);
        }
      }
    });
    it('is not offered below the amount due, with no balance, when disconnected, or once not Active', () => {
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: DUE_NOW - 1n })).finishSettlement).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: 0n, dueNow: 0n })).finishSettlement).toBe(false);
      expect(visibleActions(ctx({ account: undefined, walletMode: 'disconnected', cloneBalance: DUE_NOW })).finishSettlement).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, status: Status.Funded, buyer: BUYER, cloneBalance: DUE_NOW })).finishSettlement).toBe(false);
    });
    it('is offered at a 100% discount once any amount has arrived', () => {
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: 1n, dueNow: 0n })).finishSettlement).toBe(true);
    });
  });

  describe('Accept and settle', () => {
    it('is offered to the seller only when 0 < balance < amount due, while Active', () => {
      expect(visibleActions(ctx({ cloneBalance: 1n })).acceptAndSettle).toBe(true);
      expect(visibleActions(ctx({ cloneBalance: DUE_NOW - 1n })).acceptAndSettle).toBe(true);
    });
    it('is not offered with no balance, a full balance, to anyone else, or once not Active', () => {
      expect(visibleActions(ctx({ cloneBalance: 0n })).acceptAndSettle).toBe(false);
      expect(visibleActions(ctx({ cloneBalance: DUE_NOW })).acceptAndSettle).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: 1n })).acceptAndSettle).toBe(false);
      expect(visibleActions(ctx({ status: Status.Funded, buyer: BUYER, cloneBalance: 1n })).acceptAndSettle).toBe(false);
    });
  });
});
