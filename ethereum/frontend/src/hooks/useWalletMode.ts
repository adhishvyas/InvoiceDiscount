import { useAccount } from 'wagmi';
import { TEMPO_WALLET_ID } from '../config';

export type WalletMode = 'tempo' | 'injected' | 'disconnected';

/** Tempo Wallet gets batching and sponsorship; any other connected wallet gets the plain two-transaction path. */
export function useWalletMode(): WalletMode {
  const { connector, isConnected } = useAccount();
  if (!isConnected) return 'disconnected';
  return connector?.id === TEMPO_WALLET_ID ? 'tempo' : 'injected';
}
