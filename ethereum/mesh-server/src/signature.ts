// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v3): exported names, signatures and documented behaviour.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A delivery whose `X-Mesh-Timestamp` is further than this from now is rejected (Mesh's recommended window). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Whether a webhook delivery is genuine and fresh (Mesh spec §4.3 webhook step 1):
 * - `signatureHeader` (`X-Mesh-Signature-256`) equals `sha256=` + the lowercase hex HMAC-SHA256, under `secret`, of
 *   the string `` `${timestampHeader}.${rawBody}` ``, compared in constant time. `rawBody` is the exact body as
 *   received: any change to its bytes, including re-serialized JSON, fails.
 * - `timestampHeader` (`X-Mesh-Timestamp`) is unix seconds (digits only) within `SIGNATURE_TOLERANCE_SECONDS` of
 *   `nowSeconds`, in either direction; exactly at the tolerance passes.
 * Missing or empty headers, a missing `sha256=` prefix, uppercase or Base64 digests, and a non-numeric timestamp → false.
 * Mesh's test vector: timestamp `1723050000`, body `test payload`, secret `test secret` →
 * `sha256=9517b777fb26cec72db9562e61b3875cc71785e362185d7bede69be942599526` (valid at `nowSeconds = 1723050000`).
 */
export function verifyMeshSignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestampHeader || !signatureHeader || !/^\d+$/.test(timestampHeader)) return false;
  if (Math.abs(nowSeconds - Number(timestampHeader)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`, 'utf8').digest('hex')}`);
  const given = Buffer.from(signatureHeader);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
