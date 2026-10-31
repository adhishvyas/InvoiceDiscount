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
