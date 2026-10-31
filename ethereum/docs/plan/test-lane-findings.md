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
| 1 | SPEC-QUESTION 1: `Transfer` logs come before the escrow event in the same call | **spec gap** | Implementation matches the tests' reading (event emitted last). Pending: the user decides whether to write it into §3.5 |
| 2 | SPEC-QUESTION 2: §3.5 says a non-ERC-20 contract "makes `fund` revert". Not true for a contract with a permissive `fallback` (SafeERC20 accepts empty return data from any address with code), which would let `fund` mark the invoice Funded with no tokens moved | **spec gap** | Implementation behaves as the agent describes. Pending: the user decides the spec wording (§3.5 / §3.9) |
| 3 | SPEC-QUESTION 3: tokens sent to an Active clone that is then funded normally stay in the clone; `triggerPayment` and `cancel` move `principal` only | **spec gap** | Implementation matches the tests' reading. Pending: the user decides whether to add it to §3.9 |

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
| 7 | SPEC-QUESTION 1 (frontend): Finish settlement when `dueNow == 0` and balance 0 | **spec gap** | TSDoc requires `0 < balance` (matching the contract's `NothingToSettle`); spec §5.3 says only "balance ≥ amount due now". Pending: user decides whether §5.3 adds "and balance > 0" |
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
