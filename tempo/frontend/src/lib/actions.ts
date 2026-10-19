import { Status, type StatusValue } from './status';

export interface ActionContext {
  /** The connected account, if any. */
  account: string | undefined;
  seller: string;
  /** address(0) until funded. */
  buyer: string;
  status: StatusValue;
  dueDate: bigint;
  /** Current unix seconds. */
  now: bigint;
}

export interface VisibleActions {
  fund: boolean;
  trigger: boolean;
  cancel: boolean;
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** Which actions to offer on the invoice page (spec §4.3). The contract has the final say. */
export function visibleActions(ctx: ActionContext): VisibleActions {
  const isSeller = same(ctx.account, ctx.seller);
  const isBuyer = ctx.status !== Status.Active && same(ctx.account, ctx.buyer);
  const open = ctx.status === Status.Active || ctx.status === Status.Funded;
  return {
    fund: ctx.account !== undefined && !isSeller && ctx.status === Status.Active,
    trigger: ctx.status === Status.Funded && (isSeller || isBuyer),
    cancel: open && (isSeller || (isBuyer && ctx.now > ctx.dueDate)),
  };
}
