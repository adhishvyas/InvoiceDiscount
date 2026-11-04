# Test-lane findings (Ethereum)

> 2026-10-30. Tests: Sonnet 5.5 (agent A), black-box from the spec and the frozen interface (`ethereum-interface-v1`), porting the Tempo suite. Implementation: Opus, main session, ported from Tempo, no sight of the tests before the merge. Merge commit `28246ae`.

## Contracts (node M1)

### Result

| Suite | Count | Result on first run after merge |
|---|---|---|
| Unit (`test/unit/`) | 154 (133 ported, 15 new, 6 harness self-tests) | all pass |
| Fork (`FOUNDRY_PROFILE=fork`, Sepolia PYUSD/USDC) | 11 (6 ported, 5 new) | all pass |
| `forge coverage` | `src/InvoiceEscrow.sol` and `src/InvoiceFactory.sol`: 100% lines, statements, branches and functions | |

Red check on the stubs (test author, before the implementation existed): 148 of 154 unit tests and 11 of 11 fork tests failed. The 6 green ones are `BaseSelfTest::test_Harness_*`, which exercise only the mocks. The test author also checked the suite against its own throw-away reference implementation (outside the repo) and 11 single-line mutations, all caught.

Isolation: the agent's list of files read contains no `tempo/contracts/src/`, no smoke tests and no Ethereum implementation.

### Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 1 | SPEC-QUESTION 1: `Transfer` logs come before the escrow event in the same call | **spec gap** | Implementation matches the tests' reading (event emitted last). Approved: added to §3.5 |
| 2 | SPEC-QUESTION 2: §3.5 says a non-ERC-20 contract "makes `fund` revert". Not true for a contract with a permissive `fallback` (SafeERC20 accepts empty return data from any address with code), which would let `fund` mark the invoice Funded with no tokens moved | **spec gap** | Implementation behaves as the agent describes. Approved: §3.5 corrected, new §3.9 bullet |
| 3 | SPEC-QUESTION 3: tokens sent to an Active clone that is then funded normally stay in the clone; `triggerPayment` and `cancel` move `principal` only | **spec gap** | Implementation matches the tests' reading. Approved: §3.9 stray-tokens bullet extended |

No **impl bugs** and no **test bugs**.

### Summary

- Impl bugs: 0. Test bugs: 0. Spec gaps: 3 (all raised by new ERC-20 tests, none by the ported Tempo tests).
- Ported tests vs new ERC-20 tests: neither found an implementation bug. That's expected, since the implementation is a port of code already triaged in Tempo's M1, and the ported tests already caught Tempo's two bugs there.

## Frontend (node M2)

> Tests: Sonnet 5.5 (agent B), black-box from spec §5 and the frozen `src/lib/` signatures (`ethereum-frontend-interface-v1`), porting the Tempo Vitest suites. Implementation: Opus frontend agent, ported from Tempo, no sight of the tests. Merges `08312d7` (frontend), `9a6c1fe` (tests); ABI re-synced from the M1 contracts in `730cd8d`.

### Result

| Check | Before fixes | After fixes |
|---|---|---|
| `corepack pnpm test` (165 tests: ~55 ported, ~110 new) | 2 failed | all pass |
| `corepack pnpm build` (`tsc -b` also type-checks test files) | failed (test files) | passes |
| `corepack pnpm lint` | 1 error (test file) | passes |

Red check on the stubs (test author): 150 of 165 failed. The 15 green ones are `config.test.ts` (10) and `lib/constants.test.ts` (5), which test data written in full at the tag. Isolation: the agent read only Tempo `*.test.ts` files, the specs, the plan and the frozen `src/lib/` + `config.ts`.

### Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 4 | `lib.test.ts` › ref › decodes without the zero padding | **impl bug** | `decodeRef(bytes32(0))` returned `'\u0000'`, not `''` (viem `hexToString` keeps one zero byte). Inherited from Tempo; unreachable there because the contract rejects a zero reference. Fixed by the frontend agent (`1014f3d`) |
| 5 | `lib.test.ts` › validateInvoiceForm › applies the amount rules at the selected token decimals | **impl bug** | `decimals: 0` built the invalid regex `\d{1,0}` and threw. Inherited from Tempo (always 6 decimals there). Fixed (`1014f3d`): whole numbers only at 0 decimals |
| 6 | `errors.test.ts`, `fetch.test.ts` type errors (TS2739, TS2352) and one `no-explicit-any` | **test bug** | The test author only ran Vitest, which doesn't type-check. Fixed by agent B (`e8a813b`) with no assertion changes |
| 7 | SPEC-QUESTION 1 (frontend): Finish settlement when `dueNow == 0` and balance 0 | **spec gap** | TSDoc requires `0 < balance` (matching the contract's `NothingToSettle`); spec §5.3 says only "balance ≥ amount due now". Approved: §5.3 adds "and balance > 0" |
| 8 | SPEC-QUESTION 2–4 (frontend): checksummed addresses in history output; `friendlyError` on a bare string; bad-checksum token address rejected | **spec gap** (minor) | Tests take the reading the implementation already has. No spec change proposed |

### Summary

- Impl bugs: 2 (both from new tests: an all-zero reference and 0 decimals, edge cases that Tempo's fixed 6 decimals and on-chain checks hid). Test bugs: 1 (type and lint errors). Spec gaps: 2 (one proposed §5.3 wording change).

## Overall

| Class | Contracts | Frontend |
|---|---|---|
| Impl bug | 0 | 2 |
| Test bug | 0 | 1 |
| Spec gap | 3 | 2 |

Every impl bug was found by a new test, not a ported one; both were latent in the Tempo code.

## Mesh pay-now: frontend (node M2 of [`mesh-pay-now-dag.md`](mesh-pay-now-dag.md))

> 2026-11-03. Tests: Sonnet 5.5 (agent B), black-box from Mesh spec §5 and the frozen `src/lib/actions.ts`, `src/lib/meshSession.ts` and `src/config.ts` at `ethereum-frontend-interface-v2` (`410a1c1`); branch `ethereum-frontend-mesh-tests` (`5fe6433`). Implementation: Opus frontend agent, F2–F4 on `ethereum-frontend-mesh` (`2fb9e27`, `636b3c7`, `08fff4d`), no sight of the tests. Merges `49f515c` (frontend), `98d8c49` (tests).

### Result

| Check | First run after merge |
|---|---|
| `corepack pnpm test` (186 tests: 51 new or changed by agent B, 135 existing) | all pass |
| `corepack pnpm build` (`tsc -b` type-checks test files too) | passes |
| `corepack pnpm lint` | passes |

Red check on the stubs (test author): 51 of 51 new or changed `actions` and `meshSession` tests failed; the 2 new `config` tests passed, since `config.ts` is data written in full at the tag (as in port M2). Before the merge, the implementation branch's `tsc -b` failed only on 3 errors in the old `actions.test.ts` (missing `meshSupported`/`payWithMesh`), which agent B's branch fixes. Isolation: agent B's list of files read stays inside its brief (no other `src/lib` bodies, pages, hooks, `mesh-server/src`, `tempo/frontend/src` or `actions.ts` history).

### Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 9 | SPEC-QUESTION 5: `payWithMesh` when `dueNow == 0` (a 100% discount tier) | **spec gap** (minor) | Tests and implementation both read `cloneBalance < dueNow` literally (false). Consistent with mesh-server's `409 already paid` (balance ≥ due) and with Mesh needing a non-zero amount. No spec change proposed |
| 10 | SPEC-QUESTION 6: "unset" `VITE_MESH_SERVER_URL` tested as an empty string | **spec gap** (minor) | Same as the existing config tests; `|| undefined` makes them equal. No spec change proposed |

No **impl bugs** and no **test bugs**.

### Implementation notes (frontend agent, beyond the plan's wording)

- `@meshconnect/web-link-sdk` **3.15.0**, pinned without S1 (Mesh auth is blocked): `createLink(options)` then `link.openLink(linkToken)`; callbacks `onTransferFinished(payload)` and `onExit(error?, summary?)`, from the package's `.d.ts`. pnpm warns about an unmet `bs58@^6` peer in its Solana dependencies.
- The SDK is **loaded lazily** on Continue to Mesh: importing it injects a prewarm iframe (`web.meshconnect.com/prewarm`) into every page, even with `VITE_MESH_SERVER_URL` unset. It's in its own 309 kB chunk.
- The Pay with Mesh section stays on screen while a flow is running, even after `payWithMesh` turns false (the balance reaching the amount due would otherwise hide the progress line).
- Once `expiresAt` passes, the confirm button becomes "Quote expired; get a new one".

## Mesh pay-now: mesh-server (node M1 of [`mesh-pay-now-dag.md`](mesh-pay-now-dag.md))

> 2026-11-03. Tests: Sonnet 5.5 (agent A), black-box from the Mesh spec and the frozen stubs and TSDoc at `ethereum-mesh-server-interface-v1` (`546ea29`); branch `ethereum-mesh-server-tests` (`bc1d685`, fixes `b07fc2e`). Implementation: Opus, main session, V3–V5 (`bc19ffa`, `03a8f5e`), no sight of the tests before the merge. Merges `4c65873`, `a5d26cd`.

### Result

| Check | First run after merge | After fixes |
|---|---|---|
| `corepack pnpm test` (204 tests: ~13 ported, 186 new, 5 fake-chain self-tests) | 4 failed | all pass |
| `corepack pnpm typecheck` | passes | passes |
| Coverage (`src/` without `index.ts`, `env.ts`, `abi/`, test files) | lines 98.9%: `app.ts` 98.1%, `webhook.ts` 98.4%, `invoice.ts` 100%, `mesh.ts` 100% (branches 80%: network-error and non-JSON paths) | |

Red check on the stubs (test author): 199 of 204 failed; the 5 green ones are `fakeChain.test.ts` self-tests, which import no stubbed module. Isolation: agent A's list of files read contains only the docs, the stubs, `tempo/mpp-server/src/fakeChain.ts` and its `*.test.ts` files, and viem's `waitForTransactionReceipt` source. Its worktree, like the frontend agent's, started at an old commit (`55fe394`); it reset to the tag before writing.

### Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 11 | `app.test.ts` › "reflects the state after a webhook"; "settles end to end … dedups a retried delivery" | **test bug** | The fixture put 90 PYUSD in the clone before `POST …/mesh-session`; at `T` the due amount is 85 (15% tier), so the route correctly answered `409 already paid` (which the suite's own test asserts). Fixed by agent A (`b07fc2e`): the balance is set after the session starts |
| 12 | `app.test.ts` › "401 for a missing … signature"; "401 before 400" | **test bug** | The helper's default `signature = sign(body)` also applies to an explicit `undefined`, so "unsigned" requests were signed. Fixed (`b07fc2e`): `null` sends no header |
| 13 | SPEC-QUESTION 1: zero amount due (`409` at the route vs `balance > 0` in the processor) | **spec gap** (minor) | Same edge as finding 9. Both rules are as specified; a 100%-discount invoice can't use Pay with Mesh. No change proposed |
| 14 | SPEC-QUESTION 2: a signed JSON array is `400` | **spec gap** (wording) | TSDoc says "not a JSON object"; spec §4.3 says "isn't JSON". Proposed: spec says "isn't a JSON object" |
| 15 | SPEC-QUESTION 3: `expiresAt` from the block timestamp, not wall-clock time | **spec gap** (wording) | Spec §4.3 step 7 says "now + 600 s" (written in S2); TSDoc says `t + 600`. Proposed: spec says "the latest block's timestamp + 600 s" |
| 16 | SPEC-QUESTION 4: a redelivered `EventId` that ended in `needs-attention` isn't re-evaluated | **spec gap** (none needed) | By design: the route always answers `200`, so Mesh doesn't redeliver; a refused payment is finished with Finish settlement. No change |
| 17 | SPEC-QUESTION 5: `Succeeded` after `Failed` settles | **spec gap** (none needed) | The chain decides; settling a clone that holds the funds is right. No change |
| 18 | SPEC-QUESTIONS 6, 7: not tested (status when `toMeshAmount` throws in the route; whether an ignored event's `EventId` counts as seen) | **spec gap** (none needed) | Unreachable at 6 decimals (the route then answers Hono's `500`); the implementation marks every `EventId` seen on arrival. No change |

No **impl bugs**.

### Summary

- Impl bugs: 0. Test bugs: 2 (4 tests). Spec gaps: 6, of which 2 are proposed wording changes (findings 14, 15).
- Ported vs new tests: the ~13 ported quote and clone-check tests all passed first time, as expected for code copied from `mpp-server`. All 4 failures were in new HTTP-layer tests, from fixture setup and a JavaScript default-parameter trap, not from behaviour.

## Mesh pay-now: mesh-server v2 (node M3 of [`mesh-pay-now-dag.md`](mesh-pay-now-dag.md#mesh-pay-v2-change-after-s1))

> 2026-11-03. After the Mesh spike found the v2 API, the interface was re-frozen at `ethereum-mesh-server-interface-v2` (`94d2a22`), **built on the v1 stub lineage** so the test agent again saw only stubs. Tests: Sonnet 5.5 (agent A), `7db0e55` on `ethereum-mesh-server-tests`. Implementation: Opus, main session, V7 (`50012ce`). Merge `M3` below.

### Result

| Check | First run after merge |
|---|---|
| `corepack pnpm test` (288 tests: 84 kept, ~116 rewritten, ~88 new, 4 removed) | all pass |
| `corepack pnpm typecheck` | passes |
| Coverage (as M1) | lines 99.1%: `app.ts` 98.2%, `webhook.ts` 98.6%, `mesh.ts` 100% (branches 85.7%) |

Red check (test author): 283 of 288 failed against the v2 stubs; the 5 green ones are `fakeChain.test.ts` self-tests. Live checks before the merge (main session): the real `createMeshClient` minted one OAuth token for two sandbox sessions, and a wrong secret gave `MeshApiError` 401; `verifyMeshSignature` passes Mesh's published test vector. Isolation: agent A's file list contains the docs, the v2 stubs and its own tests only.

### Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 19 | SPEC-QUESTION 8: `completed` with no `source` | **spec gap** (none needed) | Payer left empty, settlement proceeds. No change |
| 20 | SPEC-QUESTIONS 9, 10, 13: exact token-cache boundary; `audience` with a port; `previous_status` ignored, any 2xx accepted | **spec gap** (none needed) | Mesh hosts have no port (implementation uses `URL.host`); the boundary second is immaterial. No change |
| 21 | SPEC-QUESTION 11: both destination and network mismatch | **spec gap** (none needed) | The implementation reports `destination mismatch` (checked first). No change |
| 22 | SPEC-QUESTION 12: non-Mesh token with no symbol in the webhook passes the "when present" check | **spec gap** (none needed) | It can only settle a clone that already holds the full amount due, which is correct (the chain decides); the symbol check is a guard, not the gate. No change |

No **impl bugs** and no **test bugs**. (v1 questions 2 and 3 are resolved by the v2 TSDoc; 1, 4 and 5 stand as logged in M1.)

## Mesh pay-now: frontend v2 (node M4)

> 2026-11-03. F5 by the Opus frontend agent: `9fe08ee` (lib types only, tag `ethereum-frontend-interface-v3`) and `ac43e1d` (SDK swap). Merge `f3624bd`. No test-agent run: the lib change is type-only (plan F5).

| Check | Result |
|---|---|
| `corepack pnpm test` | 186 pass |
| `corepack pnpm build`, `lint` | pass |

Notes: `@meshpayhq/link-web-sdk` **0.0.10**, `openLink(token, clientId, options): LinkHandle`. `onExit` receives `{ status: 'success' | 'canceled' }`, but `canceled` also covers closing Link after paying, so the hook polls on either and ignores `status` (spec §5). A session still `awaiting-transfer` after `expiresAt` stops polling ("No payment arrived before the quote expired."). `handle.close()` on unmount (new; F3 didn't close Link).
