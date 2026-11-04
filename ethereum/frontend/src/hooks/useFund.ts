import { useCallback } from 'react';
import { erc20Abi, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { useCapabilities } from 'wagmi';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { fundPath } from '../lib/fundPath';
import { useInvoiceWrite } from './useInvoiceWrite';

/**
 * approve + fund: one atomic batch if the wallet supports it (spec §5.2), otherwise two transactions. For an ETH
 * invoice, one `fund` transaction carrying the principal as `value` (native-ETH spec §4).
 */
export function useFund(token: Address | undefined) {
  const { state, run, reset, wrongChain } = useInvoiceWrite();
  // A wallet without EIP-5792 errors here; `data` stays undefined and the path is sequential.
  const { data: capabilities } = useCapabilities({ chainId: sepolia.id });
  const path = token === undefined ? undefined : fundPath(capabilities?.atomic?.status, token);

  const fund = useCallback(
    (invoice: Address, token: Address, principal: bigint, refundAddress: Address) =>
      path === 'native'
        ? run([{ address: invoice, abi: invoiceEscrowAbi, functionName: 'fund', args: [refundAddress], value: principal }])
        : run(
            [
              { address: token, abi: erc20Abi, functionName: 'approve', args: [invoice, principal] },
              { address: invoice, abi: invoiceEscrowAbi, functionName: 'fund', args: [refundAddress] },
            ],
            path === 'batch',
          ),
    [run, path],
  );

  return { state, fund, reset, path, wrongChain };
}
