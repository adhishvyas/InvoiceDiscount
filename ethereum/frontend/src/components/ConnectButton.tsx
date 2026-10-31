import { sepolia } from 'viem/chains';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { ETH_FAUCET_URL } from '../config';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function GasNote() {
  return (
    <span className="text-xs text-slate-500">
      Every action costs Sepolia ETH for gas.{' '}
      <a href={ETH_FAUCET_URL} target="_blank" rel="noreferrer" className="underline hover:text-slate-300">
        Get some from a faucet
      </a>
    </span>
  );
}

export default function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  if (isConnected && address) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-3">
          {chainId !== sepolia.id && (
            <button
              onClick={() => switchChain({ chainId: sepolia.id })}
              disabled={switching}
              className="text-xs bg-amber-600 hover:bg-amber-500 px-3 py-1.5 rounded-full transition-colors disabled:opacity-50"
            >
              Switch to Sepolia
            </button>
          )}
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1.5 rounded-full">{short(address)}</span>
          <button onClick={() => disconnect()} className="text-xs text-slate-400 hover:text-white transition-colors">
            Disconnect
          </button>
        </div>
        {switchError && <span className="text-xs text-red-400">{switchError.message}</span>}
        <GasNote />
      </div>
    );
  }

  const injected = connectors[0];

  return (
    <div className="flex flex-col items-end gap-1">
      {injected && (
        <button
          onClick={() => connect({ connector: injected })}
          disabled={isPending}
          className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          Connect wallet
        </button>
      )}
      {error && <span className="text-xs text-red-400">{error.message}</span>}
      <GasNote />
    </div>
  );
}
