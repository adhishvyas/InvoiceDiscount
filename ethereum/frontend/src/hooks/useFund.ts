import { useCallback } from 'react';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { useInvoiceWrite } from './useInvoiceWrite';

/** approve + fund: one batched transaction on Tempo Wallet, two transactions on an injected wallet. */
export function useFund() {
  const { state, run, reset } = useInvoiceWrite();

  const fund = useCallback(
    (invoice: Address, token: Address, principal: bigint, refundAddress: Address) =>
      run([
        { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [invoice, principal] }) },
        { to: invoice, data: encodeFunctionData({ abi: invoiceEscrowAbi, functionName: 'fund', args: [refundAddress] }) },
      ]),
    [run],
  );

  return { state, fund, reset };
}
