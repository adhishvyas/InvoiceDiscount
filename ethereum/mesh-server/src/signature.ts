// INTERFACE FREEZE (tag ethereum-mesh-server-interface-v1): exported names, signatures and documented behaviour.

/**
 * Whether `header` (the `X-Mesh-Signature-256` value) is the Base64 HMAC-SHA256 of `rawBody` under `secret`
 * (Mesh spec §4.3; format per §6.1, to confirm). `rawBody` is the exact request body as received: any change to its
 * bytes, including re-serialized JSON, fails. Missing, empty or malformed headers → false. Compared in constant time.
 */
export function verifyMeshSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  throw new Error('unimplemented');
}
