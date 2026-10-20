// Test helper: a viem client whose transport answers from in-memory fixtures instead of an RPC.
import {
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { tempoModerato } from 'viem/chains';

export interface FakeContract {
  abi: Abi;
  /** Return value per function name, or a function of the decoded args. */
  reads: Record<string, unknown | ((args: readonly unknown[]) => unknown)>;
}

export interface FakeChain {
  code?: Record<Address, Hex>;
  contracts?: Record<Address, FakeContract>;
  timestamp?: bigint;
}

export function fakeClient(chain: FakeChain) {
  const lower = <T>(record: Record<string, T> = {}) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, T>;
  const code = lower(chain.code);
  const contracts = lower(chain.contracts);

  return createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        switch (method) {
          case 'eth_chainId':
            return numberToHex(tempoModerato.id);
          case 'eth_getCode':
            return code[(params[0] as string).toLowerCase()] ?? '0x';
          case 'eth_getBlockByNumber':
            return { number: '0x1', timestamp: numberToHex(chain.timestamp ?? 0n), hash: `0x${'00'.repeat(32)}` };
          case 'eth_call': {
            const { to, data } = params[0] as { to: string; data: Hex };
            const contract = contracts[to.toLowerCase()];
            if (!contract) return '0x';
            const { functionName, args = [] } = decodeFunctionData({ abi: contract.abi, data });
            const read = contract.reads[functionName];
            const result = typeof read === 'function' ? read(args) : read;
            return encodeFunctionResult({ abi: contract.abi, functionName, result } as never);
          }
          default:
            throw new Error(`fakeClient: unhandled ${method}`);
        }
      },
    }),
  });
}
