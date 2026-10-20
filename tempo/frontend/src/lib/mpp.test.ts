import { describe, expect, it } from 'vitest';
import { challengeView, receiptView } from './mpp';

/** Captured from `mpp-server`'s pay endpoint (100 AlphaUSD invoice, 15% tier). */
const WWW_AUTHENTICATE =
  'Payment id="wYezt2VM2SOmM6v3LCuVqn5ZuaYxjxvUDLggB92iEDk", realm="localhost", method="tempo", intent="charge", request="eyJhbW91bnQiOiI4NTAwMDAwMCIsImN1cnJlbmN5IjoiMHgyMEMwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibWV0aG9kRGV0YWlscyI6eyJjaGFpbklkIjo0MjQzMX0sInJlY2lwaWVudCI6IjB4MTlkMGZGQmNhNDdCRmRjRkU4M0VGOWViQzYyMjA4NjAxNzViNjJhQiJ9", description="Invoice INV-42: 15% early-payment discount", expires="2026-10-20T05:30:10.992Z", opaque="eyJfbXBweF9ub25jZSI6IjB4MGIzZDI3ZTAzYWZiMWRkNjQyYmQ4NDI1OGFjZTg0ZjhmOGU5MzcyZmRkZmI3ZjIzNTQ2MGE1NGIwNDQ4MjQ3MyIsImRpc2NvdW50QnBzIjoiMTUwMCJ9"';
const PAYMENT_RECEIPT =
  'eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4YWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYiIsInN0YXR1cyI6InN1Y2Nlc3MiLCJ0aW1lc3RhbXAiOiIyMDI2LTEwLTE5VDEyOjAwOjAwLjAwMFoifQ';

describe('challengeView', () => {
  it('decodes the 402 the server sends', () => {
    const response = new Response(null, { status: 402, headers: { 'WWW-Authenticate': WWW_AUTHENTICATE } });
    expect(challengeView(response)).toEqual({
      status: 402,
      header: WWW_AUTHENTICATE,
      method: 'tempo',
      intent: 'charge',
      amount: 85_000_000n,
      currency: '0x20C0000000000000000000000000000000000001',
      recipient: '0x19d0fFBca47BFdcFE83EF9ebC6220860175b62aB',
      expires: '2026-10-20T05:30:10.992Z',
      description: 'Invoice INV-42: 15% early-payment discount',
    });
  });
  it('throws on a response with no Challenge', () => {
    expect(() => challengeView(new Response(null, { status: 404 }))).toThrow();
  });
});

describe('receiptView', () => {
  it('decodes a Payment-Receipt header', () => {
    expect(receiptView(PAYMENT_RECEIPT)).toEqual({
      header: PAYMENT_RECEIPT,
      method: 'tempo',
      reference: `0x${'ab'.repeat(32)}`,
      status: 'success',
      timestamp: '2026-10-19T12:00:00.000Z',
    });
  });
});
