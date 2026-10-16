import {
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Contract,
  Address,
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  Operation,
  Asset,
  xdr,
  rpc,
} from '@stellar/stellar-sdk';

const { Server, assembleTransaction, Api } = rpc;
import { signTransaction } from '@stellar/freighter-api';

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = 'https://soroban-testnet.stellar.org';

// A throw-away account used as source for read-only simulations when no wallet is connected.
const SIMULATION_ACCOUNT = new Account(Keypair.random().publicKey(), '0');

const PYUSD_ISSUER = 'GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G';
const PYUSD_CODE = 'PYUSD';
const PYUSD_DECIMALS = 7;

export const PYUSD_CONTRACT_ID = new Asset(PYUSD_CODE, PYUSD_ISSUER).contractId(Networks.TESTNET);

const server = new Server(RPC_URL);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscountTier {
  cutoff: number;       // unix timestamp (seconds)
  discount_bps: number; // e.g. 1500 = 15%
}

export type InvoiceStatus = 'Active' | 'Funded' | 'Paid' | 'Cancelled';

export interface InvoiceState {
  seller: string;
  buyer: string | null; // null until funded
  token: string;
  principal: bigint;
  due_date: number;
  tiers: DiscountTier[];
  status: InvoiceStatus;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function pyusdToUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** PYUSD_DECIMALS));
}

export function unitsToPyusd(units: bigint): number {
  return Number(units) / 10 ** PYUSD_DECIMALS;
}

export function activeDiscount(tiers: DiscountTier[], nowSec: number): number {
  for (const tier of tiers) {
    if (nowSec < tier.cutoff) return tier.discount_bps;
  }
  return 0;
}

function encodeTier(tier: DiscountTier): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('cutoff'),
      val: nativeToScVal(BigInt(tier.cutoff), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('discount_bps'),
      val: nativeToScVal(tier.discount_bps, { type: 'u32' }),
    }),
  ]);
}

function decodeInvoiceState(retval: xdr.ScVal): InvoiceState {
  const raw = scValToNative(retval) as Record<string, unknown>;
  // Soroban unit enum variants serialize as scvVec([scvSymbol(name)]), decoded to string[]
  const status = (raw.status as string[])[0] as InvoiceStatus;
  const tiersRaw = raw.tiers as Array<{ cutoff: bigint; discount_bps: number }>;

  return {
    seller: raw.seller as string,
    buyer: raw.buyer != null ? (raw.buyer as string) : null,
    token: raw.token as string,
    principal: raw.principal as bigint,
    due_date: Number(raw.due_date as bigint),
    tiers: tiersRaw.map(t => ({
      cutoff: Number(t.cutoff),
      discount_bps: Number(t.discount_bps),
    })),
    status,
  };
}

async function sendSorobanTx(tx: ReturnType<TransactionBuilder['build']>): Promise<string> {
  const simResult = await server.simulateTransaction(tx);

  if (Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = assembleTransaction(tx, simResult as Api.SimulateTransactionSuccessResponse).build();

  const result = await signTransaction(preparedTx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
  if (result.error) throw new Error(`Signing cancelled or failed`);

  const submitResult = await server.sendTransaction(
    TransactionBuilder.fromXDR(result.signedTxXdr, NETWORK_PASSPHRASE)
  );
  if (submitResult.status === 'ERROR') throw new Error('Transaction submission failed');

  const hash = submitResult.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const txResult = await server.getTransaction(hash);
    if (txResult.status === 'SUCCESS') return hash;
    if (txResult.status === 'FAILED') throw new Error('Transaction failed on-chain');
  }
  throw new Error('Transaction timed out after 60s');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function deployInvoice(params: {
  seller: string;
  principalUnits: bigint;
  dueDate: number;
  tiers: DiscountTier[];
}): Promise<string> {
  const wasmHash = import.meta.env.VITE_WASM_HASH as string;
  if (!wasmHash) throw new Error('VITE_WASM_HASH not configured in .env');

  const account = await server.getAccount(params.seller);
  const salt = crypto.getRandomValues(new Uint8Array(32));

  // Tx 1: create contract instance
  const deployTx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(params.seller),
        wasmHash: hexToBytes(wasmHash),
        salt,
      })
    )
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(deployTx);
  if (Api.isSimulationError(simResult)) {
    throw new Error(`Deploy simulation failed: ${simResult.error}`);
  }

  const successSim = simResult as Api.SimulateTransactionSuccessResponse;
  const contractId = Address.fromScAddress(successSim.result!.retval.address()).toString();

  const preparedDeploy = assembleTransaction(deployTx, successSim).build();
  const deploySign = await signTransaction(preparedDeploy.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
  if (deploySign.error) throw new Error('Deploy signing cancelled');

  const deploySubmit = await server.sendTransaction(
    TransactionBuilder.fromXDR(deploySign.signedTxXdr, NETWORK_PASSPHRASE)
  );
  if (deploySubmit.status === 'ERROR') throw new Error('Deploy transaction failed');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await server.getTransaction(deploySubmit.hash);
    if (r.status === 'SUCCESS') break;
    if (r.status === 'FAILED') throw new Error('Deploy failed on-chain');
    if (i === 29) throw new Error('Deploy timed out');
  }

  // Tx 2: initialize
  const freshAccount = await server.getAccount(params.seller);
  const contract = new Contract(contractId);

  const initTx = new TransactionBuilder(freshAccount, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'initialize',
        new Address(params.seller).toScVal(),
        new Address(PYUSD_CONTRACT_ID).toScVal(),
        nativeToScVal(params.principalUnits, { type: 'i128' }),
        nativeToScVal(BigInt(params.dueDate), { type: 'u64' }),
        xdr.ScVal.scvVec(params.tiers.map(encodeTier)),
      )
    )
    .setTimeout(300)
    .build();

  await sendSorobanTx(initTx);
  return contractId;
}

export async function fundInvoice(contractId: string, buyer: string): Promise<void> {
  const account = await server.getAccount(buyer);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('fund', new Address(buyer).toScVal()))
    .setTimeout(300)
    .build();

  await sendSorobanTx(tx);
}

export async function triggerPayment(contractId: string, caller: string): Promise<void> {
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('trigger_payment', new Address(caller).toScVal()))
    .setTimeout(300)
    .build();

  await sendSorobanTx(tx);
}

export async function cancelInvoice(contractId: string, caller: string): Promise<void> {
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('cancel', new Address(caller).toScVal()))
    .setTimeout(300)
    .build();

  await sendSorobanTx(tx);
}

export async function getInvoice(contractId: string, source?: string): Promise<InvoiceState> {
  const account = source
    ? await server.getAccount(source)
    : SIMULATION_ACCOUNT;
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_invoice'))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (Api.isSimulationError(simResult)) {
    throw new Error(`Failed to read invoice: ${simResult.error}`);
  }

  const successResult = simResult as Api.SimulateTransactionSuccessResponse;
  if (!successResult.result?.retval) throw new Error('No result from get_invoice');

  return decodeInvoiceState(successResult.result.retval);
}

// Add PYUSD trustline (classic Stellar operation, not Soroban)
export async function addPyusdTrustline(publicKey: string): Promise<void> {
  // Use Horizon for classic operations
  const { Horizon } = await import('@stellar/stellar-sdk');
  const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

  const account = await horizon.loadAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset(PYUSD_CODE, PYUSD_ISSUER),
      })
    )
    .setTimeout(30)
    .build();

  const result = await signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE });
  if (result.error) throw new Error('Trustline signing cancelled');

  await horizon.submitTransaction(TransactionBuilder.fromXDR(result.signedTxXdr, NETWORK_PASSPHRASE));
}
