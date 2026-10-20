import type { WalletMode } from '../hooks/useWalletMode';
import { Status, type StatusValue } from './status';

export interface ActionContext {
  /** The connected account, if any. */
  account: string | undefined;
  walletMode: WalletMode;
  /** Whether `MPP_SERVER_URL` is set. */
  mppEnabled: boolean;
  seller: string;
  /** address(0) until funded. */
  buyer: string;
  status: StatusValue;
  dueDate: bigint;
  /** Current unix seconds. */
  now: bigint;
  /** The invoice's own token balance (direct payments sent to it). */
  cloneBalance: bigint;
  /** What `settleDirect()` requires now: the principal less the current discount. */
  dueNow: bigint;
}

export interface VisibleActions {
  fund: boolean;
  trigger: boolean;
  cancel: boolean;
  payNow: boolean;
  finishSettlement: boolean;
  acceptAndSettle: boolean;
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** Which actions to offer on the invoice page (spec §4.3, MPP spec §5.1). The contract has the final say. */
export function visibleActions(ctx: ActionContext): VisibleActions {
  const connected = ctx.account !== undefined;
  const isSeller = same(ctx.account, ctx.seller);
  const isBuyer = ctx.status !== Status.Active && same(ctx.account, ctx.buyer);
  const active = ctx.status === Status.Active;
  const open = active || ctx.status === Status.Funded;
  const paidInFull = ctx.cloneBalance > 0n && ctx.cloneBalance >= ctx.dueNow;
  return {
    fund: connected && !isSeller && active,
    trigger: ctx.status === Status.Funded && (isSeller || isBuyer),
    cancel: open && (isSeller || (isBuyer && ctx.now > ctx.dueDate)),
    // Not once the invoice already holds enough: that would pay twice. Finish settlement is offered instead.
    payNow: ctx.mppEnabled && ctx.walletMode === 'tempo' && !isSeller && active && !paidInFull,
    finishSettlement: connected && active && paidInFull,
    acceptAndSettle: isSeller && active && ctx.cloneBalance > 0n && ctx.cloneBalance < ctx.dueNow,
  };
}
