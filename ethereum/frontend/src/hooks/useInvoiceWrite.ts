import { useCallback, useState } from 'react';
import type { Abi, Address, Hex, TransactionReceipt } from 'viem';
import { sepolia } from 'viem/chains';
import { useAccount, useConfig } from 'wagmi';
import { sendCalls, waitForCallsStatus, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { friendlyError } from '../lib/errors';

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Wei sent with the call (native-ETH `fund`). */
  value?: bigint;
}

export type WriteState =
  | { status: 'idle' }
  /** `hash` is set as soon as the wallet returns it (not for a batch, which has no hash until it is included). */
  | { status: 'pending'; hash?: Hex }
  | { status: 'success'; receipts: TransactionReceipt[] }
  | { status: 'error'; message: string; hash?: Hex };

/**
 * Sends one or more contract calls in order, on Sepolia, and waits for one confirmation each.
 * `atomic`: one EIP-5792 `wallet_sendCalls` batch with `forceAtomic` (only when the wallet reports `supported`);
 * otherwise one transaction per call, each confirmed before the next. Gas is paid in Sepolia ETH by the sender.
 */
export function useInvoiceWrite() {
  const config = useConfig();
  const { isConnected, chainId } = useAccount();
  const [state, setState] = useState<WriteState>({ status: 'idle' });
  /** Writes are disabled until the wallet switches to Sepolia. */
  const wrongChain = isConnected && chainId !== sepolia.id;

  const run = useCallback(
    async (calls: Call[], atomic = false): Promise<TransactionReceipt[] | undefined> => {
      setState({ status: 'pending' });
      let hash: Hex | undefined;
      try {
        const receipts: TransactionReceipt[] = [];
        if (atomic) {
          const { id } = await sendCalls(config, {
            chainId: sepolia.id,
            calls: calls.map(({ address, ...call }) => ({ to: address, ...call })),
            forceAtomic: true,
          });
          const result = await waitForCallsStatus(config, { id });
          hash = result.receipts?.[0]?.transactionHash;
          if (result.status !== 'success' || !hash) throw new Error('Batch failed');
          receipts.push(await waitForTransactionReceipt(config, { hash }));
        } else {
          for (const call of calls) {
            hash = await writeContract(config, { ...call, chainId: sepolia.id });
            setState({ status: 'pending', hash });
            receipts.push(await waitForTransactionReceipt(config, { hash }));
          }
        }
        if (receipts.some((r) => r.status !== 'success')) throw new Error('Transaction reverted');
        setState({ status: 'success', receipts });
        return receipts;
      } catch (e) {
        setState({ status: 'error', message: friendlyError(e), hash });
        return undefined;
      }
    },
    [config],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, run, reset, wrongChain };
}
