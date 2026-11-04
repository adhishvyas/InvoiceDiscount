import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMeshSignature } from './signature';

const SECRET = 'whsec_abc123';
const BODY = '{"event_id":"e1","data":{"transfer":{"status":"completed"}}}';
const NOW = 1_800_000_000;
const hex = (body: string, ts: string | number, secret = SECRET) =>
  createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
const sig = (body: string, ts: string | number, secret = SECRET) => `sha256=${hex(body, ts, secret)}`;

describe('verifyMeshSignature', () => {
  it("accepts Mesh's test vector", () => {
    expect(
      verifyMeshSignature(
        'test payload',
        '1723050000',
        'sha256=9517b777fb26cec72db9562e61b3875cc71785e362185d7bede69be942599526',
        'test secret',
        1_723_050_000,
      ),
    ).toBe(true);
  });

  it("rejects Mesh's test vector with a wrong secret, body or timestamp", () => {
    const header = 'sha256=9517b777fb26cec72db9562e61b3875cc71785e362185d7bede69be942599526';
    expect(verifyMeshSignature('test payload', '1723050000', header, 'test secret', 1_723_050_000)).toBe(true);
    expect(verifyMeshSignature('test payload', '1723050000', header, 'other secret', 1_723_050_000)).toBe(false);
    expect(verifyMeshSignature('test payload!', '1723050000', header, 'test secret', 1_723_050_000)).toBe(false);
    expect(verifyMeshSignature('test payload', '1723050001', header, 'test secret', 1_723_050_000)).toBe(false);
  });

  it('accepts the hex HMAC of "timestamp.body"', () => {
    expect(verifyMeshSignature(BODY, String(NOW), sig(BODY, NOW), SECRET, NOW)).toBe(true);
  });

  it('accepts a body with non-ASCII characters, signed over its UTF-8 bytes', () => {
    const body = '{"venue":"café ✓"}';
    expect(verifyMeshSignature(body, String(NOW), sig(body, NOW), SECRET, NOW)).toBe(true);
  });

  it('defaults to the current time', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyMeshSignature(BODY, String(now), sig(BODY, now), SECRET)).toBe(true);
    const old = now - 400;
    expect(verifyMeshSignature(BODY, String(old), sig(BODY, old), SECRET)).toBe(false);
  });

  it.each([-300, -1, 0, 1, 300])('accepts a timestamp %i s from now (tolerance is inclusive)', (offset) => {
    const ts = NOW + offset;
    expect(verifyMeshSignature(BODY, String(ts), sig(BODY, ts), SECRET, NOW)).toBe(true);
  });

  it.each([-301, -301_000, 301, 86_400])('rejects a correctly signed timestamp %i s from now', (offset) => {
    const ts = NOW + offset;
    expect(verifyMeshSignature(BODY, String(ts), sig(BODY, ts), SECRET, NOW)).toBe(false);
  });

  it('rejects a body whose bytes changed, including re-serialized JSON', () => {
    const header = sig(BODY, NOW);
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyMeshSignature(pretty, String(NOW), header, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(`${BODY} `, String(NOW), header, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY.replace('completed', 'failed'), String(NOW), header, SECRET, NOW)).toBe(false);
  });

  it('binds the timestamp: the same digest with another (fresh) timestamp fails', () => {
    expect(verifyMeshSignature(BODY, String(NOW + 1), sig(BODY, NOW), SECRET, NOW)).toBe(false);
  });

  it('rejects the old scheme: a digest of the body alone', () => {
    const bodyOnly = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
    expect(verifyMeshSignature(BODY, String(NOW), bodyOnly, SECRET, NOW)).toBe(false);
  });

  it('rejects another secret', () => {
    expect(verifyMeshSignature(BODY, String(NOW), sig(BODY, NOW, 'other'), SECRET, NOW)).toBe(false);
  });

  it('rejects missing or empty headers', () => {
    const header = sig(BODY, NOW);
    expect(verifyMeshSignature(BODY, undefined, header, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, '', header, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, String(NOW), undefined, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, String(NOW), '', SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, undefined, undefined, SECRET, NOW)).toBe(false);
  });

  it('rejects a Base64 digest, an uppercase digest and a missing sha256= prefix', () => {
    const digest = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest();
    const ts = String(NOW);
    expect(verifyMeshSignature(BODY, ts, digest.toString('base64'), SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, ts, `sha256=${digest.toString('base64')}`, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, ts, `sha256=${digest.toString('hex').toUpperCase()}`, SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, ts, digest.toString('hex'), SECRET, NOW)).toBe(false);
    expect(verifyMeshSignature(BODY, ts, `SHA256=${digest.toString('hex')}`, SECRET, NOW)).toBe(false);
  });

  it('rejects malformed signature headers without throwing (length mismatch, spaces, truncation)', () => {
    const good = sig(BODY, NOW);
    const ts = String(NOW);
    for (const header of ['sha256=', 'sha256=abc', 'abc', good.slice(0, -2), `${good}00`, ` ${good}`, `${good} `, `${good}\n`, 'sha256=' + 'g'.repeat(64)]) {
      expect(verifyMeshSignature(BODY, ts, header, SECRET, NOW)).toBe(false);
    }
  });

  it.each(['abc', '17230500.5', '-1', '+1800000000', ' 1800000000', '1800000000 ', '1.8e9', '0x6b49d200', 'NaN', 'Infinity'])(
    'rejects a non-numeric timestamp %j even when the signature matches it',
    (ts) => {
      expect(verifyMeshSignature(BODY, ts, sig(BODY, ts), SECRET, NOW)).toBe(false);
    },
  );
});
