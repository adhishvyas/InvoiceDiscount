import type { StatusValue } from './status';

/** What the invoice page knows when it decides which buttons to show. */
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
  /** The invoice's own token balance (direct payments sent to it). */
  cloneBalance: bigint;
  /** What `settleDirect()` requires now: the principal less the current discount. */
  dueNow: bigint;
}

/** One flag per action button on the invoice page. */
export interface VisibleActions {
  fund: boolean;
  trigger: boolean;
  cancel: boolean;
  finishSettlement: boolean;
  acceptAndSettle: boolean;
}

/**
 * Which actions to offer on the invoice page (spec §5.3). The contract has the final say.
 * Addresses compare case-insensitively. The buyer counts only once the invoice has left Active, so `buyer`
 * being address(0) never makes anyone a party. With `account` undefined, every flag is false.
 * - `fund`: connected, not the seller, Active.
 * - `trigger`: Funded, and the account is the seller or the buyer.
 * - `cancel`: Active or Funded, and the account is the seller, or the buyer with `now > dueDate` (strictly).
 * - `finishSettlement`: connected (anyone), Active, and `0 < cloneBalance` and `cloneBalance >= dueNow`.
 * - `acceptAndSettle`: the seller, Active, and `0 < cloneBalance < dueNow`.
 */
export function visibleActions(ctx: ActionContext): VisibleActions {
  throw new Error('unimplemented');
}
