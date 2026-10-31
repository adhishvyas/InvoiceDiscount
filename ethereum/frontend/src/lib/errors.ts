/**
 * A short message to show for a failed write (spec §5.2).
 * - Insufficient funds for gas: when `error`, or any error in its `cause` chain, is viem's `InsufficientFundsError`
 *   or has a message matching /insufficient funds/i → `'You need Sepolia ETH to pay gas'`.
 * - Any other `Error`: its viem `shortMessage` if it has one, else its `message`.
 * - A non-Error value: `String(error)`.
 */
export function friendlyError(error: unknown): string {
  throw new Error('unimplemented');
}
