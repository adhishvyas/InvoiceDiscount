import { useCallback, useState } from 'react';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { useConfig, useSendTransaction, useSendTransactionSync } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { useWalletMode } from './useWalletMode';

export interface Call {
  to: Address;
  data: Hex;
}

/** The receipt fields callers use; the Tempo sync action types `status` more loosely than viem's receipt. */
export type Receipt = Pick<TransactionReceipt, 'transactionHash' | 'logs'> & { status: string };

export type WriteState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'success'; receipts: Receipt[] }
  | { status: 'error'; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);

/**
 * Sends one or more calls in order.
 * Tempo Wallet: a single atomic, fee-sponsored transaction carrying every call.
 * Injected wallet: one transaction per call, each confirmed before the next; the user pays fees.
 */
export function useInvoiceWrite() {
  const mode = useWalletMode();
  const config = useConfig();
  const sendSync = useSendTransactionSync();
  const send = useSendTransaction();
  const [state, setState] = useState<WriteState>({ status: 'idle' });

  const run = useCallback(
    async (calls: Call[]): Promise<Receipt[] | undefined> => {
      setState({ status: 'pending' });
      try {
        const receipts: Receipt[] = [];
        if (mode === 'tempo') {
          receipts.push(await sendSync.mutateAsync({ calls, feePayer: true }));
        } else {
          for (const call of calls) {
            const hash = await send.mutateAsync(call);
            receipts.push(await waitForTransactionReceipt(config, { hash }));
          }
        }
        if (receipts.some((r) => r.status !== 'success')) throw new Error('Transaction reverted');
        setState({ status: 'success', receipts });
        return receipts;
      } catch (e) {
        setState({ status: 'error', message: errorMessage(e) });
        return undefined;
      }
    },
    [mode, config, sendSync, send],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, run, reset };
}
