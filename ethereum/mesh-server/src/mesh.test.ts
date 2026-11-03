import { describe, expect, it } from 'vitest';
import { fakeFetch, NETWORK_ID, CLONE } from './fakeChain';
import { linkTokenRequestBody, MeshApiError, requestLinkToken, type LinkTokenParams } from './mesh';

const params: LinkTokenParams = {
  invoice: '0x19D0FfBcA47bfDcfE83eF9ebC6220860175B62AB',
  symbol: 'PYUSD',
  amount: 90,
  networkId: NETWORK_ID,
  transactionId: `${CLONE}-0123456789abcdef`,
  userId: 'buyer-0123456789abcdef',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const config = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://mesh.example',
  clientId: 'client-id-1',
  apiKey: 'secret-key-1',
  fetch,
});

describe('linkTokenRequestBody', () => {
  it('is a fixed payment to the invoice with one toAddresses entry', () => {
    expect(linkTokenRequestBody(params)).toEqual({
      userId: 'buyer-0123456789abcdef',
      restrictMultipleAccounts: true,
      transferOptions: {
        transferType: 'payment',
        transactionId: `${CLONE}-0123456789abcdef`,
        isInclusiveFeeEnabled: false,
        generatePayLink: false,
        toAddresses: [{ networkId: NETWORK_ID, symbol: 'PYUSD', address: params.invoice, amount: 90 }],
      },
    });
  });

  it('passes the address through as given', () => {
    const lower = linkTokenRequestBody({ ...params, invoice: CLONE });
    expect(lower.transferOptions.toAddresses[0].address).toBe(CLONE);
  });

  it('passes a fractional amount through as a number', () => {
    expect(linkTokenRequestBody({ ...params, amount: 0.000284 }).transferOptions.toAddresses[0].amount).toBe(0.000284);
  });
});

describe('requestLinkToken', () => {
  it('POSTs the body to /api/v1/linktoken with the client headers and returns content.linkToken', async () => {
    const fetch = fakeFetch(() => json({ content: { linkToken: 'lt_abc' } }));
    expect(await requestLinkToken(config(fetch), params)).toBe('lt_abc');
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call.url).toBe('https://mesh.example/api/v1/linktoken');
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-client-id')).toBe('client-id-1');
    expect(call.headers.get('x-client-secret')).toBe('secret-key-1');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual(JSON.parse(JSON.stringify(linkTokenRequestBody(params))));
  });

  it.each([400, 401, 403, 429, 500, 503])('throws a MeshApiError with status %i on a non-2xx response', async (status) => {
    const fetch = fakeFetch(() => json({ error: 'nope' }, status));
    const err = await requestLinkToken(config(fetch), params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(status);
  });

  it('throws a MeshApiError with the non-2xx status even when the body is not JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await requestLinkToken(config(fetch), params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(502);
  });

  it('throws with the 2xx status when the body is not JSON', async () => {
    const fetch = fakeFetch(() => new Response('ok', { status: 200 }));
    const err = await requestLinkToken(config(fetch), params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(200);
  });

  it.each([
    ['content missing', {}],
    ['linkToken at the top level', { linkToken: 'lt' }],
    ['content is null', { content: null }],
    ['empty linkToken', { content: { linkToken: '' } }],
    ['numeric linkToken', { content: { linkToken: 123 } }],
    ['null linkToken', { content: { linkToken: null } }],
    ['body is an array', []],
    ['body is null', null],
  ])('throws with the 2xx status when %s', async (_name, body) => {
    const fetch = fakeFetch(() => json(body, 201));
    const err = await requestLinkToken(config(fetch), params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(201);
  });

  it('throws a MeshApiError with an undefined status when fetch rejects', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const err = await requestLinkToken(config(fetch), params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBeUndefined();
  });
});
