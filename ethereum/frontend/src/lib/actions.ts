import { Status, type StatusValue } from './status';

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
  /** `MESH_SERVER_URL` is set and the invoice token is in `MESH_TOKENS`; computed by the page. */
  meshSupported: boolean;
}

/** One flag per action button on the invoice page. */
export interface VisibleActions {
  fund: boolean;
  trigger: boolean;
  cancel: boolean;
  finishSettlement: boolean;
  acceptAndSettle: boolean;
  payWithMesh: boolean;
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Which actions to offer on the invoice page (spec §5.3). The contract has the final say.
 * Addresses compare case-insensitively. The buyer counts only once the invoice has left Active, so `buyer`
 * being address(0) never makes anyone a party. With `account` undefined, every flag is false except `payWithMesh`.
 * - `fund`: connected, not the seller, Active.
 * - `trigger`: Funded, and the account is the seller or the buyer.
 * - `cancel`: Active or Funded, and the account is the seller, or the buyer with `now > dueDate` (strictly).
 * - `finishSettlement`: connected (anyone), Active, and `0 < cloneBalance` and `cloneBalance >= dueNow`.
 * - `acceptAndSettle`: the seller, Active, and `0 < cloneBalance < dueNow`.
 * - `payWithMesh` (Mesh spec §5): `meshSupported`, Active, `cloneBalance < dueNow`, and the account isn't the seller.
 *   No account connected counts as not the seller, so this is the one flag that can be true with no account.
 */
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
    finishSettlement: connected && active && paidInFull,
    acceptAndSettle: isSeller && active && ctx.cloneBalance > 0n && ctx.cloneBalance < ctx.dueNow,
    payWithMesh: ctx.meshSupported && active && ctx.cloneBalance < ctx.dueNow && !isSeller,
  };
}
