import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';
import { fetchInvoiceHistory } from './history';
import { LOG_PAGE_SIZE, findExistingInvoice } from './logs';

const FACTORY = getAddress('0x00000000000000000000000000000000000000f0');
const INVOICE = getAddress('0x00000000000000000000000000000000000000e1');
const OTHER_INVOICE = getAddress('0x00000000000000000000000000000000000000e2');
const TOKEN = getAddress('0x00000000000000000000000000000000000000a0');
const SELLER = getAddress('0x00000000000000000000000000000000000000a1');
const OTHER_SELLER = getAddress('0x00000000000000000000000000000000000000a2');
const BUYER = getAddress('0x00000000000000000000000000000000000000b2');
const PAYER = getAddress('0x00000000000000000000000000000000000000d4');
const REF = `0x${'41'.padEnd(64, '0')}` as const;
const OTHER_REF = `0x${'42'.padEnd(64, '0')}` as const;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const erc20Abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

interface FakeLog {
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  topics: Hex[];
  data: Hex;
}

function makeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  where: { address: Address; blockNumber: bigint; tx: number },
): FakeLog {
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const item = abi.find((i) => i.type === 'event' && i.name === eventName) as {
    inputs: { name: string; type: string; indexed: boolean }[];
  };
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
  return { address: where.address, blockNumber: where.blockNumber, transactionHash: tx(where.tx), topics, data };
}

/** A fake JSON-RPC node holding `logs`; honours address, block range and topic filters like a real one. */
function fakeNode(head: bigint, logs: FakeLog[], opts: { failLogs?: boolean } = {}) {
  const getLogsCalls: { address: unknown; topics: unknown; from: bigint; to: bigint }[] = [];
  const client = createClient({
    transport: custom({
      async request({ method, params }) {
        const p = (params ?? []) as any[];
        if (method === 'eth_blockNumber') return numberToHex(head);
        if (method === 'eth_getBlockByNumber') {
          const n = /^0x/.test(p[0]) ? BigInt(p[0]) : head; // a tag such as 'latest' means the head
          return { number: numberToHex(n), hash: tx(Number(n)), timestamp: numberToHex(n * 12n), transactions: [] };
        }
        if (method === 'eth_getLogs') {
          if (opts.failLogs) throw new Error('rpc exploded');
          const f = p[0];
          const from = BigInt(f.fromBlock);
          const to = BigInt(f.toBlock);
          getLogsCalls.push({ address: f.address, topics: f.topics, from, to });
          const addrs =
            f.address === undefined ? undefined : ([] as string[]).concat(f.address).map((a) => a.toLowerCase());
          return logs
            .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
            .filter((l) => !addrs || addrs.includes(l.address.toLowerCase()))
            .filter((l) =>
              ((f.topics ?? []) as (string | string[] | null)[]).every((t, i) => {
                if (t === null || t === undefined) return true;
                const want = ([] as string[]).concat(t).map((x) => x.toLowerCase());
                return l.topics[i] !== undefined && want.includes(l.topics[i].toLowerCase());
              }),
            )
            .map((l, i) => ({
              ...l,
              blockNumber: numberToHex(l.blockNumber),
              blockHash: tx(Number(l.blockNumber)),
              logIndex: numberToHex(i),
              transactionIndex: '0x0',
              removed: false,
            }));
        }
        throw new Error(`unexpected RPC method ${method}`);
      },
    }),
  });
  return { client, getLogsCalls };
}

const created = (invoice: Address, seller: Address, ref: Hex, blockNumber: bigint, n: number) =>
  makeLog(
    invoiceFactoryAbi as Abi,
    'InvoiceCreated',
    { invoice, seller, invoiceRef: ref, token: TOKEN, principal: 1_000_000n, dueDate: 9_999_999_999n },
    { address: FACTORY, blockNumber, tx: n },
  );

describe('findExistingInvoice', () => {
  it('returns the invoice this seller created with this reference', async () => {
    const { client } = fakeNode(1_000n, [created(INVOICE, SELLER, REF, 500n, 1)]);
    expect(await findExistingInvoice(client, FACTORY, 100n, SELLER, REF)).toBe(INVOICE);
  });
  it('ignores other sellers and other references', async () => {
    const { client } = fakeNode(1_000n, [
      created(OTHER_INVOICE, OTHER_SELLER, REF, 400n, 1),
      created(OTHER_INVOICE, SELLER, OTHER_REF, 500n, 2),
    ]);
    expect(await findExistingInvoice(client, FACTORY, 100n, SELLER, REF)).toBeUndefined();
  });
  it('ignores matching events from another contract', async () => {
    const stray = { ...created(OTHER_INVOICE, SELLER, REF, 500n, 1), address: OTHER_INVOICE };
    const { client } = fakeNode(1_000n, [stray]);
    expect(await findExistingInvoice(client, FACTORY, 100n, SELLER, REF)).toBeUndefined();
  });
  it('scans from fromBlock to the latest block in pages no bigger than the RPC limit, with no gaps', async () => {
    const head = 35_000n;
    const { client, getLogsCalls } = fakeNode(head, []);
    expect(await findExistingInvoice(client, FACTORY, 5n, SELLER, REF)).toBeUndefined();
    expect(getLogsCalls.length).toBeGreaterThanOrEqual(4);
    expect(getLogsCalls[0].from).toBe(5n);
    expect(getLogsCalls.at(-1)!.to).toBe(head);
    for (const c of getLogsCalls) expect(c.to - c.from).toBeLessThan(LOG_PAGE_SIZE);
    for (let i = 1; i < getLogsCalls.length; i++) expect(getLogsCalls[i].from).toBe(getLogsCalls[i - 1].to + 1n);
  });
  it('finds a match on a later page', async () => {
    const { client } = fakeNode(35_000n, [created(INVOICE, SELLER, REF, 30_000n, 1)]);
    expect(await findExistingInvoice(client, FACTORY, 0n, SELLER, REF)).toBe(INVOICE);
  });
  it('stops at the first page with a match', async () => {
    const { client, getLogsCalls } = fakeNode(35_000n, [created(INVOICE, SELLER, REF, 100n, 1)]);
    expect(await findExistingInvoice(client, FACTORY, 0n, SELLER, REF)).toBe(INVOICE);
    expect(getLogsCalls).toHaveLength(1);
  });
  it('returns the first match when several pages match', async () => {
    const { client } = fakeNode(35_000n, [
      created(INVOICE, SELLER, REF, 100n, 1),
      created(OTHER_INVOICE, SELLER, REF, 20_000n, 2),
    ]);
    expect(await findExistingInvoice(client, FACTORY, 0n, SELLER, REF)).toBe(INVOICE);
  });
  it('propagates RPC errors', async () => {
    const { client } = fakeNode(1_000n, [], { failLogs: true });
    await expect(findExistingInvoice(client, FACTORY, 0n, SELLER, REF)).rejects.toThrow('rpc exploded');
  });
});

describe('fetchInvoiceHistory', () => {
  const escrow = (eventName: string, args: Record<string, unknown>, blockNumber: bigint, n: number, address = INVOICE) =>
    makeLog(invoiceEscrowAbi as Abi, eventName, args, { address, blockNumber, tx: n });
  const funded = escrow('Funded', { buyer: BUYER, invoiceRef: REF, refundAddress: BUYER, principal: 1_000_000n }, 150n, 2);
  const paid = escrow(
    'Paid',
    {
      caller: BUYER,
      invoiceRef: REF,
      payoutAddress: SELLER,
      toSeller: 900_000n,
      refundAddress: BUYER,
      refundToBuyer: 100_000n,
      discountBps: 1000,
    },
    160n,
    3,
  );
  const settledDirect = escrow(
    'SettledDirect',
    { caller: SELLER, invoiceRef: REF, payoutAddress: SELLER, amount: 900_000n, discountBps: 1000 },
    300n,
    6,
  );
  const transferIn = (from: Address, to: Address, value: bigint, blockNumber: bigint, n: number, address = TOKEN) =>
    makeLog(erc20Abi as Abi, 'Transfer', { from, to, value }, { address, blockNumber, tx: n });

  it('is empty when the factory never created this invoice', async () => {
    const { client } = fakeNode(1_000n, [created(OTHER_INVOICE, SELLER, REF, 100n, 1)]);
    expect(await fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN)).toEqual({});
  });
  it('builds a paid invoice, with block timestamps, and does not read token transfers', async () => {
    const { client, getLogsCalls } = fakeNode(1_000n, [created(INVOICE, SELLER, REF, 100n, 1), funded, paid]);
    const history = await fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN);
    expect(history).toEqual({
      created: { timestamp: 1200n, tx: tx(1), seller: SELLER },
      funded: { timestamp: 1800n, tx: tx(2), buyer: BUYER, invoiceRef: REF, refundAddress: BUYER, principal: 1_000_000n },
      paid: {
        timestamp: 1920n,
        tx: tx(3),
        caller: BUYER,
        invoiceRef: REF,
        payoutAddress: SELLER,
        toSeller: 900_000n,
        refundAddress: BUYER,
        refundToBuyer: 100_000n,
        discountBps: 1000,
      },
    });
    expect(getLogsCalls.some((c) => JSON.stringify(c.address).toLowerCase().includes(TOKEN))).toBe(false);
  });
  // SPEC-QUESTION 2: addresses are compared as viem decodes them (checksummed), hence getAddress() in the fixtures
  it('ignores escrow events emitted by another invoice', async () => {
    const strangerFunded = escrow(
      'Funded',
      { buyer: BUYER, invoiceRef: OTHER_REF, refundAddress: BUYER, principal: 5n },
      150n,
      9,
      OTHER_INVOICE,
    );
    const { client } = fakeNode(1_000n, [created(INVOICE, SELLER, REF, 100n, 1), strangerFunded]);
    expect((await fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN)).funded).toBeUndefined();
  });
  it('after a direct settlement, adds the token transfers into the invoice, oldest first', async () => {
    const { client } = fakeNode(1_000n, [
      created(INVOICE, SELLER, REF, 100n, 1),
      transferIn(PAYER, INVOICE, 600_000n, 250n, 5),
      transferIn(PAYER, INVOICE, 300_000n, 200n, 4),
      transferIn(PAYER, OTHER_INVOICE, 777n, 210n, 7), // to someone else
      transferIn(PAYER, INVOICE, 888n, 220n, 8, OTHER_INVOICE), // another token contract
      settledDirect,
    ]);
    const history = await fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN);
    expect(history.settledDirect).toEqual({
      timestamp: 3600n,
      tx: tx(6),
      caller: SELLER,
      invoiceRef: REF,
      payoutAddress: SELLER,
      amount: 900_000n,
      discountBps: 1000,
    });
    expect(history.inbound).toEqual([
      { timestamp: 2400n, tx: tx(4), from: PAYER, amount: 300_000n },
      { timestamp: 3000n, tx: tx(5), from: PAYER, amount: 600_000n },
    ]);
  });
  it('pages across more than one log range', async () => {
    const { client } = fakeNode(40_000n, [
      created(INVOICE, SELLER, REF, 100n, 1),
      funded,
      escrow('Cancelled', { caller: SELLER, invoiceRef: REF, refunded: 1_000_000n }, 35_000n, 10),
    ]);
    const history = await fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN);
    expect(history.cancelled).toEqual({
      timestamp: 420_000n,
      tx: tx(10),
      caller: SELLER,
      invoiceRef: REF,
      refunded: 1_000_000n,
    });
    expect(history.funded?.tx).toBe(tx(2));
  });
  it('propagates RPC errors', async () => {
    const { client } = fakeNode(1_000n, [], { failLogs: true });
    await expect(fetchInvoiceHistory(client, FACTORY, 0n, INVOICE, TOKEN)).rejects.toThrow('rpc exploded');
  });
});
