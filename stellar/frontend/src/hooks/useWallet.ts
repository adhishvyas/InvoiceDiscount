import { useState, useEffect, useCallback } from 'react';
import { isConnected, getAddress, requestAccess } from '@stellar/freighter-api';

interface WalletState {
  address: string | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    connected: false,
    loading: true,
    error: null,
  });

  const checkConnection = useCallback(async () => {
    try {
      const connResult = await isConnected();
      if (!connResult.isConnected) {
        setState({ address: null, connected: false, loading: false, error: null });
        return;
      }
      const addrResult = await getAddress();
      if (addrResult.error || !addrResult.address) {
        setState({ address: null, connected: false, loading: false, error: null });
        return;
      }
      setState({ address: addrResult.address, connected: true, loading: false, error: null });
    } catch {
      setState({ address: null, connected: false, loading: false, error: null });
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const connect = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const result = await requestAccess();
      if (result.error) {
        setState(s => ({ ...s, loading: false, error: 'Connection rejected' }));
        return;
      }
      const addrResult = await getAddress();
      if (addrResult.error || !addrResult.address) {
        setState(s => ({ ...s, loading: false, error: 'Could not get address' }));
        return;
      }
      setState({ address: addrResult.address, connected: true, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: 'Freighter not installed' }));
    }
  }, []);

  return { ...state, connect };
}
