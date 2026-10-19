import { describe, expect, it } from 'vitest';
import { visibleActions, type ActionContext } from './actions';
import { Status, type StatusValue } from './status';

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b2';
const STRANGER = '0x00000000000000000000000000000000000000c3';
const ZERO = '0x0000000000000000000000000000000000000000';
const DUE = 1_000n;

const ctx = (patch: Partial<ActionContext>): ActionContext => ({
  account: SELLER,
  seller: SELLER,
  buyer: ZERO,
  status: Status.Active,
  dueDate: DUE,
  now: DUE - 1n,
  ...patch,
});

describe('visibleActions', () => {
  it('shows nothing when disconnected', () => {
    for (const status of [0, 1, 2, 3] as StatusValue[]) {
      expect(visibleActions(ctx({ account: undefined, status, buyer: status ? BUYER : ZERO }))).toEqual({
        fund: false,
        trigger: false,
        cancel: false,
      });
    }
  });

  describe('Active (unfunded)', () => {
    it('lets the seller cancel, before and after the due date, but not fund or trigger', () => {
      for (const now of [DUE - 1n, DUE, DUE + 1n]) {
        expect(visibleActions(ctx({ now }))).toEqual({ fund: false, trigger: false, cancel: true });
      }
    });
    it('lets any other connected account fund, and nothing else', () => {
      expect(visibleActions(ctx({ account: STRANGER }))).toEqual({ fund: true, trigger: false, cancel: false });
      expect(visibleActions(ctx({ account: STRANGER, now: DUE + 1n }))).toEqual({ fund: true, trigger: false, cancel: false });
    });
  });

  describe('Funded', () => {
    const funded = (patch: Partial<ActionContext>) => ctx({ status: Status.Funded, buyer: BUYER, ...patch });
    it('lets the seller trigger and cancel at any time, but not fund', () => {
      for (const now of [DUE - 1n, DUE + 1n]) {
        expect(visibleActions(funded({ now }))).toEqual({ fund: false, trigger: true, cancel: true });
      }
    });
    it('lets the buyer trigger always, and cancel only strictly after the due date', () => {
      expect(visibleActions(funded({ account: BUYER, now: DUE - 1n }))).toEqual({ fund: false, trigger: true, cancel: false });
      expect(visibleActions(funded({ account: BUYER, now: DUE }))).toEqual({ fund: false, trigger: true, cancel: false });
      expect(visibleActions(funded({ account: BUYER, now: DUE + 1n }))).toEqual({ fund: false, trigger: true, cancel: true });
    });
    it('shows a third party nothing', () => {
      for (const now of [DUE - 1n, DUE + 1n]) {
        expect(visibleActions(funded({ account: STRANGER, now }))).toEqual({ fund: false, trigger: false, cancel: false });
      }
    });
  });

  it('shows nothing once Paid or Cancelled, for anyone', () => {
    for (const status of [Status.Paid, Status.Cancelled]) {
      for (const account of [SELLER, BUYER, STRANGER]) {
        for (const now of [DUE - 1n, DUE + 1n]) {
          expect(visibleActions(ctx({ status, buyer: BUYER, account, now }))).toEqual({
            fund: false,
            trigger: false,
            cancel: false,
          });
        }
      }
    }
  });

  it('compares addresses case-insensitively', () => {
    expect(visibleActions(ctx({ account: SELLER.toUpperCase().replace('0X', '0x') })).cancel).toBe(true);
  });
});
