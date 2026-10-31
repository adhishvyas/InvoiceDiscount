import { describe, expect, it } from 'vitest';
import { visibleActions, type ActionContext, type VisibleActions } from './actions';
import { Status, type StatusValue } from './status';

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b2';
const STRANGER = '0x00000000000000000000000000000000000000c3';
const ZERO = '0x0000000000000000000000000000000000000000';
const DUE = 1_000n;

const DUE_NOW = 900n;

const ctx = (patch: Partial<ActionContext>): ActionContext => ({
  account: SELLER,
  seller: SELLER,
  buyer: ZERO,
  status: Status.Active,
  dueDate: DUE,
  now: DUE - 1n,
  cloneBalance: 0n,
  dueNow: DUE_NOW,
  ...patch,
});

const NONE: VisibleActions = { fund: false, trigger: false, cancel: false, finishSettlement: false, acceptAndSettle: false };
/** Only the lifecycle actions, for the cases that predate direct settlement. */
const lifecycle = ({ fund, trigger, cancel }: VisibleActions) => ({ fund, trigger, cancel });

describe('visibleActions', () => {
  it('shows nothing when disconnected', () => {
    for (const status of [0, 1, 2, 3] as StatusValue[]) {
      for (const cloneBalance of [0n, DUE_NOW]) {
        expect(visibleActions(ctx({ account: undefined, status, buyer: status ? BUYER : ZERO, cloneBalance }))).toEqual(NONE);
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
    it('never makes the buyer address(0) a party', () => {
      // account is never address(0) in practice; the point is that `buyer === account` must not grant cancel while Active
      expect(visibleActions(ctx({ account: BUYER, buyer: BUYER, now: DUE + 1n })).cancel).toBe(false);
      expect(visibleActions(ctx({ account: BUYER, buyer: BUYER, now: DUE + 1n })).trigger).toBe(false);
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
    it('never offers direct-settlement actions, whatever the clone balance', () => {
      for (const account of [SELLER, BUYER, STRANGER]) {
        for (const cloneBalance of [0n, 1n, DUE_NOW, DUE_NOW + 1n]) {
          const a = visibleActions(funded({ account, cloneBalance }));
          expect(a.finishSettlement).toBe(false);
          expect(a.acceptAndSettle).toBe(false);
        }
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
    expect(visibleActions(ctx({ account: SELLER.toUpperCase().replace('0X', '0x') })).fund).toBe(false);
    expect(visibleActions(ctx({ seller: SELLER.toUpperCase().replace('0X', '0x') })).fund).toBe(false);
    const funded = ctx({ status: Status.Funded, buyer: BUYER.toUpperCase().replace('0X', '0x'), account: BUYER });
    expect(visibleActions(funded).trigger).toBe(true);
  });

  describe('Finish settlement', () => {
    it('is offered to anyone connected once the balance covers the amount due, while Active', () => {
      for (const account of [SELLER, STRANGER]) {
        expect(visibleActions(ctx({ account, cloneBalance: DUE_NOW })).finishSettlement).toBe(true);
        expect(visibleActions(ctx({ account, cloneBalance: DUE_NOW + 1n })).finishSettlement).toBe(true);
      }
    });
    it('is not offered below the amount due, with no balance, when disconnected, or once not Active', () => {
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: DUE_NOW - 1n })).finishSettlement).toBe(false);
      expect(visibleActions(ctx({ account: STRANGER, cloneBalance: 0n, dueNow: 0n })).finishSettlement).toBe(false); // SPEC-QUESTION 1
      expect(visibleActions(ctx({ account: undefined, cloneBalance: DUE_NOW })).finishSettlement).toBe(false);
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
    it('is not offered when the amount due is zero, since nothing can be below it', () => {
      expect(visibleActions(ctx({ cloneBalance: 1n, dueNow: 0n })).acceptAndSettle).toBe(false);
      expect(visibleActions(ctx({ cloneBalance: 0n, dueNow: 0n })).acceptAndSettle).toBe(false);
    });
  });

  describe('exhaustive matrix: role x status x time x clone balance', () => {
    type Role = 'disconnected' | 'seller' | 'buyer' | 'stranger';
    const accountOf: Record<Role, string | undefined> = {
      disconnected: undefined,
      seller: SELLER,
      buyer: BUYER,
      stranger: STRANGER,
    };
    /** Independent oracle, written from spec §5.3 and the TSDoc. */
    const expected = (role: Role, status: StatusValue, now: bigint, cloneBalance: bigint): VisibleActions => {
      if (role === 'disconnected') return NONE;
      const active = status === Status.Active;
      const funded = status === Status.Funded;
      const isSeller = role === 'seller';
      const isBuyer = role === 'buyer' && !active; // the buyer is a party only once funded
      return {
        fund: active && !isSeller,
        trigger: funded && (isSeller || isBuyer),
        cancel: (active || funded) && (isSeller || (isBuyer && now > DUE)),
        finishSettlement: active && cloneBalance > 0n && cloneBalance >= DUE_NOW,
        acceptAndSettle: active && isSeller && cloneBalance > 0n && cloneBalance < DUE_NOW,
      };
    };

    const roles: Role[] = ['disconnected', 'seller', 'buyer', 'stranger'];
    const statuses: StatusValue[] = [Status.Active, Status.Funded, Status.Paid, Status.Cancelled];
    // before, exactly at, and after the due date
    const nows = [DUE - 100n, DUE - 1n, DUE, DUE + 1n, DUE + 100n];
    // zero, below due, at due, above due
    const balances = [0n, 1n, DUE_NOW - 1n, DUE_NOW, DUE_NOW + 1n, 10n * DUE_NOW];

    for (const role of roles) {
      for (const status of statuses) {
        it(`${role} on ${['Active', 'Funded', 'Paid', 'Cancelled'][status]}`, () => {
          for (const now of nows) {
            for (const cloneBalance of balances) {
              const actual = visibleActions(
                ctx({
                  account: accountOf[role],
                  status,
                  buyer: status === Status.Active ? ZERO : BUYER,
                  now,
                  cloneBalance,
                }),
              );
              expect(actual, `now=${now} cloneBalance=${cloneBalance}`).toEqual(expected(role, status, now, cloneBalance));
            }
          }
        });
      }
    }
  });
});
