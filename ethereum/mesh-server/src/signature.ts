// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Whether `header` (the `X-Mesh-Signature-256` value) is the Base64 HMAC-SHA256 of `rawBody` under `secret`
 * (Mesh spec §4.3; format per §6.1, to confirm). `rawBody` is the exact request body as received: any change to its
 * bytes, including re-serialized JSON, fails. Missing, empty or malformed headers → false. Compared in constant time.
 */
export function verifyMeshSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const given = Buffer.from(header, 'base64');
  // Buffer.from(…, 'base64') skips invalid characters, so also require the header to be the canonical encoding.
  return given.length === expected.length && given.toString('base64') === header && timingSafeEqual(given, expected);
}
