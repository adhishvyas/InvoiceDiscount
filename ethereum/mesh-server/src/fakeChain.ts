// Test helper: a viem client whose transport answers from in-memory fixtures instead of an RPC, plus the shared
// fixtures ("world"), a fake `settle`, a fake Mesh `fetch` and webhook signing used by the *.test.ts files.
import { createHmac } from 'node:crypto';
import {
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  numberToHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';

export interface FakeContract {
  abi: Abi;
  /** Return value per function name, or a function of the decoded args. A function may throw to fail the call. */
  reads: Record<string, unknown | ((args: readonly unknown[]) => unknown)>;
}

export interface FakeReceipt {
  status: 'success' | 'reverted';
}

export interface FakeChain {
  code?: Record<Address, Hex>;
  contracts?: Record<Address, FakeContract>;
  /** Read on every request, so a test can move the chain forward. */
  timestamp?: bigint;
  /** Starting block number; every `eth_blockNumber` call advances it by one. */
  blockNumber?: bigint;
  /** Transaction receipts by hash. Read on every request, so a test can add one later. Absent hash: not found. */
  receipts?: Record<Hex, FakeReceipt>;
  /** Receives the JSON-RPC method of every request. */
  log?: string[];
}

export function fakeClient(chain: FakeChain) {
  const lower = <T>(record: Record<string, T> = {}) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, T>;
  const code = lower(chain.code);
  const contracts = lower(chain.contracts);
  let block = chain.blockNumber ?? 1000n;

  const findReceipt = (hash: string) =>
    Object.entries(chain.receipts ?? {}).find(([h]) => h.toLowerCase() === hash.toLowerCase())?.[1];

  return createClient({
    chain: sepolia,
    pollingInterval: 5,
    cacheTime: 0,
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        chain.log?.push(method);
        switch (method) {
          case 'eth_chainId':
            return numberToHex(sepolia.id);
          case 'eth_blockNumber':
            return numberToHex(block++);
          case 'eth_getCode':
            return code[(params[0] as string).toLowerCase()] ?? '0x';
          case 'eth_getBlockByNumber':
            return {
              number: numberToHex(block),
              timestamp: numberToHex(chain.timestamp ?? 0n),
              hash: `0x${'00'.repeat(32)}`,
              transactions: [],
            };
          case 'eth_getTransactionByHash': {
            // viem's waitForTransactionReceipt looks the transaction up (replacement detection); serve a pending one.
            const hash = params[0] as Hex;
            const mined = findReceipt(hash);
            return {
              hash,
              nonce: '0x0',
              blockHash: mined ? `0x${'11'.repeat(32)}` : null,
              blockNumber: mined ? numberToHex(block) : null,
              transactionIndex: mined ? '0x0' : null,
              from: `0x${'00'.repeat(20)}`,
              to: `0x${'00'.repeat(20)}`,
              value: '0x0',
              gas: '0x5208',
              gasPrice: '0x1',
              input: '0x',
              type: '0x0',
              v: '0x1b',
              r: '0x1',
              s: '0x1',
            };
          }
          case 'eth_getTransactionReceipt': {
            const hash = params[0] as Hex;
            const receipt = findReceipt(hash);
            if (!receipt) return null;
            return {
              transactionHash: hash,
              transactionIndex: '0x0',
              blockHash: `0x${'11'.repeat(32)}`,
              blockNumber: numberToHex(block),
              from: `0x${'00'.repeat(20)}`,
              to: `0x${'00'.repeat(20)}`,
              cumulativeGasUsed: '0x5208',
              gasUsed: '0x5208',
              effectiveGasPrice: '0x1',
              contractAddress: null,
              logs: [],
              logsBloom: `0x${'00'.repeat(256)}`,
              status: receipt.status === 'success' ? '0x1' : '0x0',
              type: '0x2',
            };
          }
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

// ---------------------------------------------------------------------------------------------------------------
// Shared fixtures

export const T = 1_800_000_000n;
export const FACTORY: Address = '0x58b4989074b20af8331c048d7535c70f534299d4';
export const IMPL: Address = '0x1619ba96564c733204173cc201f1b9d3ab9280d1';
export const CLONE: Address = '0x19d0ffbca47bfdcfe83ef9ebc6220860175b62ab';
export const CLONE_B: Address = '0x2814a70fd45740cc23ff519e66e546804fb9201c';
export const NOT_CLONE: Address = '0x00000000000000000000000000000000000000bb';
export const PYUSD: Address = '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9';
export const USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const SELLER: Address = '0x00000000000000000000000000000000000000a1';
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const WEBHOOK_SECRET = 'whsec_test_secret';
export const NETWORK_ID = '11111111-2222-3333-4444-555555555555';
export const CHAIN_NAME = 'Sepolia';

export const DEFAULT_TIERS = [
  { cutoff: T + 100n, discountBps: 1500 }, // ends inside the 900 s window, so the quote uses the next tier (1000)
  { cutoff: T + 2000n, discountBps: 1000 },
];

export interface InvoiceFixture {
  status: number;
  principal: bigint;
  token: Address;
  tiers: { cutoff: bigint; discountBps: number }[];
  dueDate: bigint;
  /** Token balance of the clone. */
  balance: bigint;
}

export interface World {
  client: ReturnType<typeof fakeClient>;
  chain: FakeChain;
  /** Live fixtures keyed by lowercase clone address. Mutate them to change what the chain answers. */
  invoices: Record<string, InvoiceFixture>;
  receipts: Record<Hex, FakeReceipt>;
  log: string[];
  decimals: Record<string, number>;
  /** When set, ERC-20 `balanceOf` fails with this message. */
  balanceError?: string;
  invoice(address: Address): InvoiceFixture;
}

/** The EIP-1167 runtime for `implementation`, built independently of `cloneRuntime`. */
export function cloneCode(implementation: Address): Hex {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

export function makeWorld(
  opts: { invoices?: Record<Address, Partial<InvoiceFixture>>; timestamp?: bigint } = {},
): World {
  const invoices: Record<string, InvoiceFixture> = {};
  for (const [address, partial] of Object.entries(opts.invoices ?? { [CLONE]: {} })) {
    invoices[address.toLowerCase()] = {
      status: 0,
      principal: 100_000_000n,
      token: PYUSD,
      tiers: DEFAULT_TIERS,
      dueDate: T + 10_000n,
      balance: 0n,
      ...partial,
    };
  }
  const receipts: Record<Hex, FakeReceipt> = {};
  const log: string[] = [];
  const world = { invoices, receipts, log, decimals: {} as Record<string, number> } as World;
  world.invoice = (address) => invoices[address.toLowerCase()]!;

  const contracts: Record<Address, FakeContract> = {
    [FACTORY]: { abi: invoiceFactoryAbi, reads: { implementation: IMPL } },
  };
  const code: Record<Address, Hex> = { [NOT_CLONE]: '0x6080604052' };
  const tokens = new Set([PYUSD, USDC, ...Object.values(invoices).map((i) => i.token)].map((a) => a.toLowerCase()));
  for (const token of tokens) {
    contracts[token as Address] = {
      abi: erc20Abi,
      reads: {
        decimals: () => world.decimals[token] ?? 6,
        balanceOf: ([holder]: readonly unknown[]) => {
          if (world.balanceError) throw new Error(world.balanceError);
          const inv = invoices[(holder as string).toLowerCase()];
          return inv && inv.token.toLowerCase() === token ? inv.balance : 0n;
        },
      },
    };
  }
  for (const address of Object.keys(invoices)) {
    code[address as Address] = cloneCode(IMPL);
    contracts[address as Address] = {
      abi: invoiceEscrowAbi,
      reads: {
        getInvoice: () => {
          const i = invoices[address]!;
          return {
            invoiceRef: `0x${'00'.repeat(31)}2a`,
            seller: SELLER,
            payoutAddress: SELLER,
            buyer: ZERO,
            refundAddress: ZERO,
            token: i.token,
            principal: i.principal,
            dueDate: i.dueDate,
            tiers: i.tiers,
            status: i.status,
          };
        },
        activeDiscount: ([ts]: readonly unknown[]) =>
          invoices[address]!.tiers.find((tier) => (ts as bigint) < tier.cutoff)?.discountBps ?? 0,
      },
    };
  }

  world.chain = { code, contracts, timestamp: opts.timestamp ?? T, receipts, log };
  world.client = fakeClient(world.chain);
  return world;
}

let hashCounter = 0;
export const newHash = (): Hash => `0x${(++hashCounter).toString(16).padStart(64, 'a')}` as Hash;

export interface FakeSettleOptions {
  /** Resolve only once this promise does. */
  gate?: Promise<void>;
  /** Reject with this instead of sending. */
  reject?: unknown;
  /** Status of the receipt the fake chain serves for the returned hash. Default `success`. */
  receipt?: 'success' | 'reverted';
  /** Hold the call this long. */
  delayMs?: number;
}

/** A `settle` that records its calls and serves the receipt of the hash it returns from `world`. */
export function fakeSettle(world: World, opts: FakeSettleOptions = {}) {
  const state = { calls: [] as Address[], hashes: [] as Hash[], active: 0, maxActive: 0 };
  const settle = async (invoice: Address): Promise<Hash> => {
    state.calls.push(invoice);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      if (opts.gate) await opts.gate;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.reject !== undefined) throw opts.reject;
      const hash = newHash();
      state.hashes.push(hash);
      world.receipts[hash] = { status: opts.receipt ?? 'success' };
      return hash;
    } finally {
      state.active--;
    }
  };
  return Object.assign(settle, { state });
}

/** A promise that a test resolves by hand. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Base64 HMAC-SHA256 of the raw body, as Mesh signs webhooks. */
export const sign = (body: string, secret: string = WEBHOOK_SECRET) =>
  createHmac('sha256', secret).update(body, 'utf8').digest('base64');

export const SESSION_ID = '0123456789abcdef';
export const SESSION_ID_2 = 'fedcba9876543210';
/** `<invoice lowercase>-<id>`, built without `encodeTransactionId`. */
export const txId = (invoice: Address, id: string = SESSION_ID) => `${invoice.toLowerCase()}-${id}`;

let eventCounter = 0;
/** A `Succeeded` webhook body for `invoice` that matches the fixtures; override anything. */
export function webhookEvent(overrides: Record<string, unknown> = {}, invoice: Address = CLONE) {
  return {
    Id: `delivery-${++eventCounter}`,
    EventId: `event-${eventCounter}`,
    TransactionId: txId(invoice),
    TransferStatus: 'Succeeded',
    TxHash: newHash(),
    Chain: CHAIN_NAME,
    Token: 'PYUSD',
    DestinationAddress: getAddress(invoice),
    SourceAccountProvider: 'Coinbase',
    SourceAddress: '0x00000000000000000000000000000000000000c1',
    RefundAddress: '0x00000000000000000000000000000000000000c2',
    ...overrides,
  };
}

export interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | undefined;
}

export const linkTokenResponse = (linkToken = 'lt_test_token') =>
  new Response(JSON.stringify({ content: { linkToken } }), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fake `fetch` answering every call with `respond(call)` and recording the calls. */
export function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response> = () => linkTokenResponse()) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
