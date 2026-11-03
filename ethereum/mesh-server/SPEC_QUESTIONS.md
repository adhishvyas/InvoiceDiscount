# Spec questions (T1)

Each entry names the reading the tests assume (marked `// SPEC-QUESTION n` in the tests).

1. **Zero amount due.** `POST mesh-session` step 4 (Mesh spec 4.3 and the `app.ts` TSDoc) says "balance >= due" is `409 already paid`, so a 100%-discount invoice with a zero balance (0 >= 0) can never start a session. The processor TSDoc instead requires `balance > 0n && balance >= due` before settling. The two rules disagree for `due == 0`. Tested as written: the route returns `409 { error: "already paid", balance: "0", due: "0" }` (app.test.ts), and a positive balance settles while a zero balance gives `insufficient balance: 0 < 0` (webhook.test.ts). Is a zero-due invoice meant to be "already paid" (and settleable by anyone with a zero balance through the contract) or should the route allow it?
2. **JSON array webhook body.** The TSDoc says a signed body that is "not a JSON object" is `400`; the spec says only "isn't JSON". Tested: `null`, numbers, strings, booleans and arrays are all `400`. Arrays are the doubtful one (an array is a JSON object in some vocabularies).
3. **`expiresAt` base.** The spec (4.3 step 7) says expiry = "now + 600 s"; the TSDoc says `t + 600` with `t` the latest block timestamp. Tested with `t + 600` (the TSDoc, the fake chain's clock is fixed at `t`; wall-clock `now` would fail it).
4. **Dedup of refused events.** "An `EventId` already seen ... (including one still being processed) -> no-op" read literally means a redelivery of an event that ended in `needs-attention` is never re-evaluated, even if the balance has since arrived. Tested literally (the redelivery does nothing); a later event with a new `EventId` is re-evaluated. Should a refused event's `EventId` stay unseen?
5. **Failed then Succeeded.** The explainer calls `Failed` final, but the TSDoc only leaves `failed` alone for later `Pending`/`Failed`; a `Succeeded` on a `failed` session proceeds (to `succeeded`, then settle). Tested literally: it settles.
6. **Not tested: `toMeshAmount` throwing inside the route.** No status code is specified for an amount a JSON number cannot hold (neither the `app.ts` HTTP contract nor the spec lists it; it is not a `MeshApiError`, so not `502`). No test pins it.
7. **Not tested: dedup of ignored events.** Whether the `EventId` of an event that was ignored (undecodable or non-clone `TransactionId`) counts as seen is unspecified.

## Tests that pass against the stubs

Only `src/fakeChain.test.ts` (self-tests of the test double: ERC-20 reads, block number/timestamp, found/reverted/late/missing receipts, clone-code helper). It imports no stubbed module, so it cannot fail against the stubs. Everything else imports a stubbed module and is expected to fail. Implemented-but-unstubbed exports (`Status`, `STATUS_NAME`, `QUOTE_WINDOW`, `MeshApiError`'s constructor) are deliberately not tested on their own so they cannot give false greens; `MeshApiError` is exercised only through `requestLinkToken`.
