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
  meshSupported: false,
  owed: 0n,
  ...patch,
});

const NONE: VisibleActions = { fund: false, trigger: false, cancel: false, finishSettlement: false, acceptAndSettle: false, payWithMesh: false, withdraw: false };
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
        payWithMesh: false, // meshSupported is false in this matrix
        withdraw: false, // owed is 0n in this matrix
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
  describe('Pay with Mesh', () => {
    const mesh = (patch: Partial<ActionContext>) => visibleActions(ctx({ meshSupported: true, account: STRANGER, ...patch })).payWithMesh;
    const FLAGS = ['fund', 'trigger', 'cancel', 'finishSettlement', 'acceptAndSettle'] as const;

    it('is offered to a connected non-seller on an unpaid Active invoice', () => {
      expect(mesh({})).toBe(true);
    });
    it('is offered with no wallet connected (no account counts as not the seller)', () => {
      expect(mesh({ account: undefined })).toBe(true);
    });
    it('is not offered to the seller, compared case-insensitively', () => {
      expect(mesh({ account: SELLER })).toBe(false);
      expect(mesh({ account: SELLER.toUpperCase().replace('0X', '0x') })).toBe(false);
      expect(mesh({ account: SELLER, seller: SELLER.toUpperCase().replace('0X', '0x') })).toBe(false);
    });
    it('is offered to the future buyer address and to a different-case non-seller', () => {
      expect(mesh({ account: BUYER, buyer: BUYER })).toBe(true);
      expect(mesh({ account: STRANGER.toUpperCase().replace('0X', '0x') })).toBe(true);
    });
    it('is offered only while Active', () => {
      for (const account of [undefined, STRANGER, BUYER, SELLER]) {
        for (const status of [Status.Funded, Status.Paid, Status.Cancelled]) {
          expect(mesh({ account, status, buyer: BUYER }), `status=${status}`).toBe(false);
        }
      }
    });
    it('is offered only while the balance is below the amount due now', () => {
      expect(mesh({ cloneBalance: 0n })).toBe(true);
      expect(mesh({ cloneBalance: 1n })).toBe(true);
      expect(mesh({ cloneBalance: DUE_NOW - 1n })).toBe(true);
      expect(mesh({ cloneBalance: DUE_NOW })).toBe(false);
      expect(mesh({ cloneBalance: DUE_NOW + 1n })).toBe(false);
      expect(mesh({ cloneBalance: 10n * DUE_NOW })).toBe(false);
    });
    it('is not offered when the amount due is zero (nothing is below it), even with no balance', () => {
      // SPEC-QUESTION 5
      expect(mesh({ dueNow: 0n, cloneBalance: 0n })).toBe(false);
      expect(mesh({ dueNow: 0n, cloneBalance: 1n })).toBe(false);
    });
    it('uses the current amount due, not a fixed one', () => {
      expect(mesh({ dueNow: 500n, cloneBalance: 499n })).toBe(true);
      expect(mesh({ dueNow: 500n, cloneBalance: 500n })).toBe(false);
      expect(mesh({ dueNow: 5_000n, cloneBalance: DUE_NOW })).toBe(true);
    });
    it('is never offered when meshSupported is false (USDC invoice or no mesh-server)', () => {
      for (const account of [undefined, STRANGER, BUYER, SELLER]) {
        for (const cloneBalance of [0n, DUE_NOW - 1n]) {
          expect(mesh({ account, cloneBalance, meshSupported: false })).toBe(false);
        }
      }
    });
    it('does not depend on the due date', () => {
      for (const now of [DUE - 100n, DUE, DUE + 1n, DUE + 100n]) expect(mesh({ now })).toBe(true);
    });

    it('with no account, every other flag stays false (only payWithMesh may be true)', () => {
      for (const meshSupported of [true, false]) {
        for (const status of [Status.Active, Status.Funded, Status.Paid, Status.Cancelled]) {
          for (const cloneBalance of [0n, 1n, DUE_NOW - 1n, DUE_NOW, DUE_NOW + 1n]) {
            const a = visibleActions(
              ctx({ account: undefined, meshSupported, status, buyer: status === Status.Active ? ZERO : BUYER, cloneBalance, now: DUE + 1n }),
            );
            for (const f of FLAGS) expect(a[f], `${f} status=${status} balance=${cloneBalance}`).toBe(false);
            expect(a.payWithMesh).toBe(meshSupported && status === Status.Active && cloneBalance < DUE_NOW);
          }
        }
      }
    });

    it('leaves the existing flags unaffected by meshSupported, across the whole matrix', () => {
      const accounts = [undefined, SELLER, BUYER, STRANGER];
      for (const account of accounts) {
        for (const status of [Status.Active, Status.Funded, Status.Paid, Status.Cancelled]) {
          for (const now of [DUE - 1n, DUE, DUE + 1n]) {
            for (const cloneBalance of [0n, 1n, DUE_NOW - 1n, DUE_NOW, DUE_NOW + 1n]) {
              const base = { account, status, now, cloneBalance, buyer: status === Status.Active ? ZERO : BUYER };
              const on = visibleActions(ctx({ ...base, meshSupported: true }));
              const off = visibleActions(ctx({ ...base, meshSupported: false }));
              for (const f of FLAGS) expect(on[f], `${f} ${JSON.stringify({ ...base, now: String(now), cloneBalance: String(cloneBalance) })}`).toBe(off[f]);
              expect(off.payWithMesh).toBe(false);
            }
          }
        }
      }
    });

    it('matches an independent oracle across role x status x balance with meshSupported on', () => {
      for (const account of [undefined, SELLER, BUYER, STRANGER]) {
        for (const status of [Status.Active, Status.Funded, Status.Paid, Status.Cancelled]) {
          for (const cloneBalance of [0n, 1n, DUE_NOW - 1n, DUE_NOW, DUE_NOW + 1n]) {
            const actual = visibleActions(ctx({ account, status, cloneBalance, meshSupported: true, buyer: status === Status.Active ? ZERO : BUYER })).payWithMesh;
            expect(actual).toBe(status === Status.Active && cloneBalance < DUE_NOW && account !== SELLER);
          }
        }
      }
    });
  });
  describe('withdraw (native ETH)', () => {
    const FLAGS = ['fund', 'trigger', 'cancel', 'finishSettlement', 'acceptAndSettle', 'payWithMesh'] as const;
    const accountOf = { seller: SELLER, buyer: BUYER, stranger: STRANGER } as const;
    const statuses: StatusValue[] = [Status.Active, Status.Funded, Status.Paid, Status.Cancelled];
    const buyerOf = (status: StatusValue) => (status === Status.Active ? ZERO : BUYER);

    it('is true iff connected and owed > 0, in every status, for seller, buyer and stranger', () => {
      for (const [role, account] of Object.entries(accountOf)) {
        for (const status of statuses) {
          for (const owed of [0n, 1n, 10n ** 18n]) {
            const a = visibleActions(ctx({ account, status, buyer: buyerOf(status), owed }));
            expect(a.withdraw, `${role} status=${status} owed=${owed}`).toBe(owed > 0n);
          }
        }
      }
    });
    it('is false with no account even if owed > 0', () => {
      for (const status of statuses) {
        expect(visibleActions(ctx({ account: undefined, status, buyer: buyerOf(status), owed: 5n })).withdraw).toBe(false);
      }
    });
    it('does not change any other flag', () => {
      for (const account of [undefined, SELLER, BUYER, STRANGER]) {
        for (const status of statuses) {
          for (const now of [DUE - 1n, DUE + 1n]) {
            for (const cloneBalance of [0n, 1n, DUE_NOW, DUE_NOW + 1n]) {
              const base = { account, status, now, cloneBalance, buyer: buyerOf(status), meshSupported: true };
              const a = visibleActions(ctx({ ...base, owed: 0n }));
              const b = visibleActions(ctx({ ...base, owed: 7n }));
              for (const f of FLAGS) expect(b[f], `${f}`).toBe(a[f]);
            }
          }
        }
      }
    });
    it('with no account every flag is false except payWithMesh, whatever owed is', () => {
      const a = visibleActions(ctx({ account: undefined, meshSupported: true, owed: 9n, cloneBalance: DUE_NOW }));
      expect({ ...a, payWithMesh: false }).toEqual(NONE);
    });
    it('a Paid or Cancelled invoice shows only withdraw when something is owed', () => {
      for (const status of [Status.Paid, Status.Cancelled]) {
        for (const account of [SELLER, BUYER, STRANGER]) {
          expect(visibleActions(ctx({ account, status, buyer: BUYER, owed: 1n }))).toEqual({ ...NONE, withdraw: true });
        }
      }
    });
    it('treats an ETH invoice (cloneBalance in wei) with the same rules', () => {
      const eth = 10n ** 18n;
      const e = (patch: Partial<ActionContext>) => ctx({ dueNow: 9n * eth / 10n, ...patch });
      expect(visibleActions(e({ account: STRANGER, cloneBalance: eth / 2n })).finishSettlement).toBe(false);
      expect(visibleActions(e({ account: STRANGER, cloneBalance: 9n * eth / 10n })).finishSettlement).toBe(true);
      expect(visibleActions(e({ cloneBalance: eth / 2n })).acceptAndSettle).toBe(true);
      expect(visibleActions(e({ account: STRANGER, cloneBalance: eth / 2n, meshSupported: true })).payWithMesh).toBe(true);
      expect(visibleActions(e({ account: STRANGER, cloneBalance: eth, owed: 3n * eth })).withdraw).toBe(true);
    });
  });
});
