import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMeshSignature } from './signature';

const SECRET = 'whsec_abc123';
const BODY = '{"EventId":"e1","TransferStatus":"Succeeded"}';
const sig = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('base64');

describe('verifyMeshSignature', () => {
  it('accepts the Base64 HMAC-SHA256 of the raw body', () => {
    expect(verifyMeshSignature(BODY, sig(BODY), SECRET)).toBe(true);
  });

  it('accepts a body with non-ASCII characters, signed over its UTF-8 bytes', () => {
    const body = '{"UserId":"buüyer ✓","note":"café"}';
    expect(verifyMeshSignature(body, sig(body), SECRET)).toBe(true);
  });

  it('rejects a body whose bytes changed, including re-serialized JSON', () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyMeshSignature(pretty, sig(BODY), SECRET)).toBe(false);
    expect(verifyMeshSignature(`${BODY} `, sig(BODY), SECRET)).toBe(false);
    expect(verifyMeshSignature(BODY.replace('Succeeded', 'Failed'), sig(BODY), SECRET)).toBe(false);
  });

  it('rejects another secret', () => {
    expect(verifyMeshSignature(BODY, sig(BODY, 'other'), SECRET)).toBe(false);
  });

  it('rejects a missing or empty header', () => {
    expect(verifyMeshSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyMeshSignature(BODY, '', SECRET)).toBe(false);
  });

  it('rejects malformed headers without throwing (length mismatch, not Base64, wrong encoding, prefix)', () => {
    const good = sig(BODY);
    const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    for (const header of ['abc', good.slice(0, -4), `${good}AAAA`, 'not base64!!', hex, `sha256=${good}`, ` ${good}`, `${good}\n`, '='.repeat(44)]) {
      expect(verifyMeshSignature(BODY, header, SECRET)).toBe(false);
    }
  });

  it('rejects a valid signature of the empty body for a non-empty body', () => {
    expect(verifyMeshSignature(BODY, sig(''), SECRET)).toBe(false);
    expect(verifyMeshSignature('', sig(''), SECRET)).toBe(true);
  });
});
