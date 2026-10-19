import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { useClient } from 'wagmi';
import { FACTORY_ADDRESS, FACTORY_DEPLOY_BLOCK } from '../config';
import { fetchInvoiceHistory } from '../lib/history';
import { readCachedHistory, writeCachedHistory } from '../lib/historyCache';

/** The invoice's lifecycle events with timestamps. Refetches when `status` changes (after fund / pay / cancel). */
export function useInvoiceHistory(invoice: Address, status: number) {
  const client = useClient();
  const enabled = client !== undefined && FACTORY_ADDRESS !== undefined && FACTORY_DEPLOY_BLOCK !== undefined;

  return useQuery({
    queryKey: ['invoice-history', invoice, status],
    enabled,
    queryFn: async () => {
      const cached = readCachedHistory(invoice);
      if (cached) return cached;
      const history = await fetchInvoiceHistory(client!, FACTORY_ADDRESS!, FACTORY_DEPLOY_BLOCK!, invoice);
      writeCachedHistory(invoice, history);
      return history;
    },
  });
}
