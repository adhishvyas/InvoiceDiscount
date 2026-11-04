import { describe, expect, it } from 'vitest';
import { CLONE, MESH_BASE_URL, NETWORK_CAIP2, deferred, fakeMesh, json } from './fakeChain';
import { createMeshClient, MeshApiError, paymentSessionBody, type MeshApiConfig, type PaymentSessionParams } from './mesh';

const params: PaymentSessionParams = {
  invoice: '0x19D0FfBcA47bfDcfE83eF9ebC6220860175B62AB',
  symbol: 'PYUSD',
  amount: '90.5',
  networkCaip2: NETWORK_CAIP2,
  clientTransactionId: `${CLONE}-0123456789abcdef`,
  userId: 'buyer-0123456789abcdef',
  idempotencyKey: 'mesh-session-0123456789abcdef',
};

const BASE = 'https://mesh.example';

/** A client over `fetch` with a fake clock the test moves (milliseconds). */
function setup(fetch: typeof globalThis.fetch, baseUrl: string = BASE) {
  const clock = { ms: 1_800_000_000_000 };
  const config: MeshApiConfig = { baseUrl, clientId: 'client-id-1', clientSecret: 'se:cret/1', fetch, now: () => clock.ms };
  return { client: createMeshClient(config), clock };
}

const tokenWith = (expires_in: number | undefined, n: number) => json({ access_token: `at_${n}`, token_type: 'Bearer', expires_in });

describe('paymentSessionBody', () => {
  it('is a fixed payment to the invoice with one toAddresses entry', () => {
    expect(paymentSessionBody(params)).toEqual({
      userId: 'buyer-0123456789abcdef',
      transferOptions: {
        type: 'TRANSFER_TYPE_PAYMENT',
        clientTransactionId: `${CLONE}-0123456789abcdef`,
        toAddresses: [{ networkCaip2: NETWORK_CAIP2, symbol: 'PYUSD', address: params.invoice, amount: '90.5' }],
      },
    });
  });

  it('passes the address through as given and the amount as a string', () => {
    const body = paymentSessionBody({ ...params, invoice: CLONE, amount: '0.000284' });
    expect(body.transferOptions.toAddresses[0].address).toBe(CLONE);
    expect(body.transferOptions.toAddresses[0].amount).toBe('0.000284');
  });

  it('does not send the idempotency key or an amount in fiat in the body', () => {
    const text = JSON.stringify(paymentSessionBody(params));
    expect(text).not.toContain('mesh-session-');
    expect(text).not.toContain('amountInFiat');
  });
});

describe('createMeshClient: accessToken', () => {
  it('mints with Basic auth and a client_credentials form for the API host and scope', async () => {
    const fetch = fakeMesh();
    const { client } = setup(fetch);
    expect(await client.accessToken()).toBe('at_1');
    expect(fetch.mints).toHaveLength(1);
    const [call] = fetch.mints;
    expect(call.url).toBe('https://mesh.example/oauth2/token');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from('client-id-1:se:cret/1').toString('base64')}`);
    expect(call.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(call.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      audience: 'mesh.example',
      scope: 'sessions:edit',
    });
  });

  it('uses the host of baseUrl as the audience', async () => {
    const fetch = fakeMesh();
    await setup(fetch, MESH_BASE_URL).client.accessToken();
    expect(new URLSearchParams(fetch.mints[0].body).get('audience')).toBe('api.sbx.meshpay.com');
    expect(fetch.mints[0].url).toBe('https://api.sbx.meshpay.com/oauth2/token');
  });

  it('does not put the credentials in the form body', async () => {
    const fetch = fakeMesh();
    await setup(fetch).client.accessToken();
    expect(fetch.mints[0].body).not.toContain('se%3Acret');
    expect(fetch.mints[0].body).not.toContain('client_secret');
  });

  it('caches the token until expires_in minus 60 s after it was minted', async () => {
    const fetch = fakeMesh({ onToken: (_c, n) => tokenWith(1800, n) });
    const { client, clock } = setup(fetch);
    expect(await client.accessToken()).toBe('at_1');
    clock.ms += 1_739_000; // 1739 s: inside 1740 s
    expect(await client.accessToken()).toBe('at_1');
    expect(fetch.mints).toHaveLength(1);
    clock.ms += 2_000; // 1741 s: past 1740 s
    expect(await client.accessToken()).toBe('at_2');
    expect(fetch.mints).toHaveLength(2);
  });

  it('measures the margin from each mint: the second token lives its own full time', async () => {
    const fetch = fakeMesh({ onToken: (_c, n) => tokenWith(1800, n) });
    const { client, clock } = setup(fetch);
    await client.accessToken();
    clock.ms += 1_741_000;
    expect(await client.accessToken()).toBe('at_2');
    clock.ms += 1_000_000;
    expect(await client.accessToken()).toBe('at_2');
    expect(fetch.mints).toHaveLength(2);
  });

  it('follows each response expires_in: a short-lived token is replaced early', async () => {
    const fetch = fakeMesh({ onToken: (_c, n) => tokenWith(120, n) });
    const { client, clock } = setup(fetch);
    await client.accessToken();
    clock.ms += 59_000;
    expect(await client.accessToken()).toBe('at_1');
    clock.ms += 2_000; // 61 s > 120 - 60
    expect(await client.accessToken()).toBe('at_2');
  });

  it('shares one mint between concurrent callers', async () => {
    const gate = deferred();
    const fetch = fakeMesh({
      onToken: async (_c, n) => {
        await gate.promise;
        return tokenWith(1800, n);
      },
    });
    const { client } = setup(fetch);
    const all = Promise.all([client.accessToken(), client.accessToken(), client.accessToken(), client.accessToken()]);
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    expect(await all).toEqual(['at_1', 'at_1', 'at_1', 'at_1']);
    expect(fetch.mints).toHaveLength(1);
  });

  it('fails every concurrent caller of a failed mint, then tries again on the next call', async () => {
    const gate = deferred();
    const fetch = fakeMesh({
      onToken: async (_c, n) => {
        if (n === 1) {
          await gate.promise;
          return json({ error: 'server_error' }, 503);
        }
        return tokenWith(1800, n);
      },
    });
    const { client } = setup(fetch);
    const both = Promise.allSettled([client.accessToken(), client.accessToken()]);
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const results = await both;
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(MeshApiError);
      expect((r as PromiseRejectedResult).reason.status).toBe(503);
    }
    expect(fetch.mints).toHaveLength(1);
    expect(await client.accessToken()).toBe('at_2');
    expect(fetch.mints).toHaveLength(2);
  });

  it.each([400, 401, 403, 429, 500, 503])('throws a MeshApiError with status %i on a non-2xx response, and does not cache it', async (status) => {
    const fetch = fakeMesh({ onToken: (_c, n) => (n === 1 ? json({ error: 'invalid_client' }, status) : tokenWith(1800, n)) });
    const { client } = setup(fetch);
    const err = await client.accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(status);
    expect(await client.accessToken()).toBe('at_2');
  });

  it('throws with the status when the non-2xx body is not JSON', async () => {
    const fetch = fakeMesh({ onToken: () => new Response('<html>bad gateway</html>', { status: 502 }) });
    const err = await setup(fetch).client.accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(502);
  });

  it.each([
    ['not JSON', new Response('ok', { status: 200 })],
    ['an empty object', json({})],
    ['an empty access_token', json({ access_token: '', expires_in: 1800 })],
    ['a numeric access_token', json({ access_token: 5, expires_in: 1800 })],
    ['a missing expires_in', json({ access_token: 'at' })],
    ['a string expires_in', json({ access_token: 'at', expires_in: '1800' })],
    ['a JSON array', json([])],
    ['null', json(null)],
  ])('throws with the 2xx status for %s, and does not cache it', async (_name, response) => {
    let first = true;
    const fetch = fakeMesh({
      onToken: (_c, n) => {
        if (first) {
          first = false;
          return response.clone();
        }
        return tokenWith(1800, n);
      },
    });
    const { client } = setup(fetch);
    const err = await client.accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(200);
    expect(await client.accessToken()).toBe('at_2');
  });

  it('throws a MeshApiError with an undefined status when fetch rejects', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const err = await setup(fetch).client.accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBeUndefined();
  });
});

describe('createMeshClient: createPaymentSession', () => {
  it('POSTs the body to /v2/sessions with the bearer token and idempotency key', async () => {
    const fetch = fakeMesh();
    const { client } = setup(fetch);
    const session = await client.createPaymentSession(params);
    expect(session).toEqual({ token: 'lt_test_token', sessionId: 'sess_1', expiresAt: '2026-11-03T13:00:00Z' });
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/oauth2/token', '/v2/sessions']);
    const [call] = fetch.sessions;
    expect(call.url).toBe('https://mesh.example/v2/sessions');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer at_1');
    expect(call.headers.get('idempotency-key')).toBe('mesh-session-0123456789abcdef');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual(JSON.parse(JSON.stringify(paymentSessionBody(params))));
  });

  it('accepts any 2xx for the session', async () => {
    const fetch = fakeMesh({ onSession: () => json({ token: 'lt', sessionId: 's', expiresAt: 'x' }, 201) });
    expect((await setup(fetch).client.createPaymentSession(params)).token).toBe('lt');
  });

  it('reuses the cached token across sessions, and shares one mint between concurrent sessions', async () => {
    const fetch = fakeMesh();
    const { client } = setup(fetch);
    await Promise.all([client.createPaymentSession(params), client.createPaymentSession({ ...params, idempotencyKey: 'k2' })]);
    await client.createPaymentSession({ ...params, idempotencyKey: 'k3' });
    expect(fetch.mints).toHaveLength(1);
    expect(fetch.sessions).toHaveLength(3);
    expect(new Set(fetch.sessions.map((c) => c.headers.get('authorization')))).toEqual(new Set(['Bearer at_1']));
    expect(fetch.sessions.map((c) => c.headers.get('idempotency-key')).sort()).toEqual(['k2', 'k3', 'mesh-session-0123456789abcdef']);
  });

  it('mints a new token after the cached one expires', async () => {
    const fetch = fakeMesh({ onToken: (_c, n) => tokenWith(1800, n) });
    const { client, clock } = setup(fetch);
    await client.createPaymentSession(params);
    clock.ms += 1_800_000;
    await client.createPaymentSession(params);
    expect(fetch.sessions.map((c) => c.headers.get('authorization'))).toEqual(['Bearer at_1', 'Bearer at_2']);
  });

  it('drops the cached token on a 401, throws, and does not retry', async () => {
    const fetch = fakeMesh({
      onSession: (_c, n) =>
        n === 1 ? json({ error: { code: 'unauthorized', message: 'token expired', requestId: 'req_1' } }, 401) : json({ token: 'lt2', sessionId: 's2', expiresAt: 'x' }),
    });
    const { client } = setup(fetch);
    const err = await client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(fetch.sessions).toHaveLength(1);
    expect(fetch.mints).toHaveLength(1);
    expect((await client.createPaymentSession(params)).token).toBe('lt2');
    expect(fetch.mints).toHaveLength(2);
    expect(fetch.sessions[1].headers.get('authorization')).toBe('Bearer at_2');
  });

  it('keeps the cached token on other errors', async () => {
    const fetch = fakeMesh({ onSession: (_c, n) => (n === 1 ? json({ error: { code: 'rate_limited' } }, 429) : undefined!) });
    const { client } = setup(fetch);
    await client.createPaymentSession(params).catch(() => undefined);
    await client.createPaymentSession(params).catch(() => undefined);
    expect(fetch.mints).toHaveLength(1);
  });

  it('takes status and code from the error envelope', async () => {
    const fetch = fakeMesh({
      onSession: () => json({ error: { code: 'invalid_request', message: 'bad amount', requestId: 'req_9', details: [] } }, 400),
    });
    const err = await setup(fetch).client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_request');
  });

  it.each([
    ['an HTML body', new Response('<html>oops</html>', { status: 502 }), 502],
    ['a JSON body without error', json({ message: 'x' }, 500), 500],
    ['an error without a code', json({ error: { message: 'x' } }, 422), 422],
    ['a non-string code', json({ error: { code: 42 } }, 400), 400],
    ['a string error', json({ error: 'invalid_request' }, 400), 400],
  ])('has the status and no code for %s', async (_name, response, status) => {
    const fetch = fakeMesh({ onSession: () => response.clone() });
    const err = await setup(fetch).client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(status);
    expect(err.code).toBeUndefined();
  });

  it.each([
    ['not JSON', new Response('ok', { status: 200 })],
    ['an empty object', json({})],
    ['an empty token', json({ token: '', sessionId: 's' })],
    ['a numeric token', json({ token: 5, sessionId: 's' })],
    ['a null token', json({ token: null })],
    ['a JSON array', json([])],
  ])('throws with the 2xx status when the session response is %s', async (_name, response) => {
    const fetch = fakeMesh({ onSession: () => response.clone() });
    const err = await setup(fetch).client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(200);
  });

  it('throws a MeshApiError with an undefined status when the session fetch rejects', async () => {
    const real = fakeMesh();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v2/sessions')) throw new TypeError('fetch failed');
      return real(input, init);
    }) as typeof globalThis.fetch;
    const err = await setup(fetch).client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBeUndefined();
  });

  it('throws the mint failure and makes no session call when the token cannot be minted', async () => {
    const fetch = fakeMesh({ onToken: () => json({ error: 'invalid_client' }, 401) });
    const err = await setup(fetch).client.createPaymentSession(params).catch((e) => e);
    expect(err).toBeInstanceOf(MeshApiError);
    expect(err.status).toBe(401);
    expect(fetch.sessions).toHaveLength(0);
  });
});
