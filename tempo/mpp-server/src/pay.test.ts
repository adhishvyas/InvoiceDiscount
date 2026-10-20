import { describe, expect, it } from 'vitest';
import { Challenge, PaymentRequest } from 'mppx';
import { getAddress, stringToHex, type Address } from 'viem';
import { invoiceEscrowAbi } from './abi/InvoiceEscrow';
import { invoiceFactoryAbi } from './abi/InvoiceFactory';
import { createApp } from './app';
import { fakeClient } from './fakeChain';
import { cloneRuntime, Status } from './invoice';

const FACTORY: Address = '0x1A6934651E179448e131C453E96Ee90856b65fF8';
const IMPL: Address = '0xBC5F24f523997328cA71CD371125911574195Dda';
const CLONE: Address = '0x19d0ffbca47bfdcfe83ef9ebc6220860175b62ab';
const NOT_CLONE: Address = '0x00000000000000000000000000000000000000bb';
const TOKEN: Address = '0x20c0000000000000000000000000000000000002';
const T = 1_800_000_000n;

const tiers = [
  { cutoff: T + 100n, discountBps: 1500 }, // ends inside the 180 s window, so the quote uses the next tier
  { cutoff: T + 2000n, discountBps: 1000 },
];

const app = (status: number) =>
  createApp({
    allowedOrigin: 'http://localhost:5173',
    pay: {
      client: fakeClient({
        timestamp: T,
        code: { [CLONE]: cloneRuntime(IMPL), [NOT_CLONE]: '0x6080604052' },
        contracts: {
          [FACTORY]: { abi: invoiceFactoryAbi, reads: { implementation: IMPL } },
          [CLONE]: {
            abi: invoiceEscrowAbi,
            reads: {
              getInvoice: {
                invoiceRef: stringToHex('INV-42', { size: 32 }),
                seller: '0x00000000000000000000000000000000000000a1',
                payoutAddress: '0x00000000000000000000000000000000000000a1',
                buyer: '0x0000000000000000000000000000000000000000',
                refundAddress: '0x0000000000000000000000000000000000000000',
                token: TOKEN,
                principal: 100_000_000n,
                dueDate: T + 10_000n,
                tiers,
                status,
              },
              activeDiscount: ([ts]: readonly unknown[]) =>
                tiers.find((tier) => (ts as bigint) < tier.cutoff)?.discountBps ?? 0,
            },
          },
        },
      }),
      factory: FACTORY,
      secretKey: 'a'.repeat(64),
    },
  });

const pay = (address: string, status: number = Status.Active) =>
  app(status).request(`/invoices/${address}/pay`, { method: 'POST' });

describe('POST /invoices/:address/pay', () => {
  it('is 400 for an invalid address', async () => {
    expect((await pay('0x123')).status).toBe(400);
  });

  it('is 404 for an address that is not a clone of the factory implementation', async () => {
    expect((await pay(NOT_CLONE)).status).toBe(404);
  });

  it('is 409 with the status name for an invoice that is not Active', async () => {
    const res = await pay(CLONE, Status.Funded);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'Funded' });
  });

  it('is 402 with a Challenge for the quoted amount, paid to the invoice in its token', async () => {
    const res = await pay(CLONE);
    expect(res.status).toBe(402);

    const challenges = Challenge.fromResponseList(res);
    expect(challenges).toHaveLength(1);
    const [challenge] = challenges;
    expect(challenge.method).toBe('tempo');
    expect(challenge.intent).toBe('charge');
    expect(challenge.request).toMatchObject({
      amount: '90000000',
      currency: getAddress(TOKEN),
      recipient: getAddress(CLONE),
    });
    expect(challenge.description).toBe('Invoice INV-42: 10% early-payment discount');
    expect(PaymentRequest.deserialize(challenge.opaque!)).toMatchObject({ discountBps: '1000' });
    expect(Challenge.verify(challenge, { secretKey: 'a'.repeat(64) })).toBe(true);

    const expiresIn = new Date(challenge.expires!).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(110_000);
    expect(expiresIn).toBeLessThanOrEqual(120_000);
  });
});
