import { InsufficientFundsError } from 'viem';

/**
 * A short message to show for a failed write (spec §5.2).
 * - Insufficient funds for gas: when `error`, or any error in its `cause` chain, is viem's `InsufficientFundsError`
 *   or has a message matching /insufficient funds/i → `'You need Sepolia ETH to pay gas'`.
 * - Any other `Error`: its viem `shortMessage` if it has one, else its `message`.
 * - A non-Error value: `String(error)`.
 */
export function friendlyError(error: unknown): string {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof InsufficientFundsError || /insufficient funds/i.test(e.message)) return 'You need Sepolia ETH to pay gas';
  }
  return error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
}
