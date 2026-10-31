/**
 * How to send approve + fund (spec §5.2), from the wallet's EIP-5792 `atomic.status` for the account on Sepolia
 * (`useCapabilities`).
 * - `'supported'` → `'batch'`: one `wallet_sendCalls` with `[approve, fund]` and `forceAtomic: true`.
 * - `'ready'` (the wallet would first upgrade the account via EIP-7702, which the PoC doesn't trigger),
 *   `'unsupported'`, or `undefined` (no EIP-5792 support, or Sepolia absent from the capabilities) → `'sequential'`:
 *   `approve`, wait for its receipt, then `fund`.
 */
export function fundPath(atomicStatus: 'supported' | 'ready' | 'unsupported' | undefined): 'batch' | 'sequential' {
  return atomicStatus === 'supported' ? 'batch' : 'sequential';
}
