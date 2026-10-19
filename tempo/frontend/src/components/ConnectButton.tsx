import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { TEMPO_WALLET_ID } from '../config';
import { useWalletMode } from '../hooks/useWalletMode';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const mode = useWalletMode();

  if (isConnected && address) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1.5 rounded-full">{short(address)}</span>
          <button onClick={() => disconnect()} className="text-xs text-slate-400 hover:text-white transition-colors">
            Disconnect
          </button>
        </div>
        {mode === 'injected' && (
          <span className="text-xs text-slate-500">You pay network fees in a stablecoin, so keep a balance.</span>
        )}
      </div>
    );
  }

  const tempo = connectors.find((c) => c.id === TEMPO_WALLET_ID);
  const other = connectors.find((c) => c.id !== TEMPO_WALLET_ID);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {tempo && (
          <button
            onClick={() => connect({ connector: tempo })}
            disabled={isPending}
            className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            Connect Tempo Wallet
          </button>
        )}
        {other && (
          <button
            onClick={() => connect({ connector: other })}
            disabled={isPending}
            className="text-sm bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            Other wallet
          </button>
        )}
      </div>
      {error && <span className="text-xs text-red-400">{error.message}</span>}
    </div>
  );
}
