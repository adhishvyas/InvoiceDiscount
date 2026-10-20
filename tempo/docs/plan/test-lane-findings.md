# Test-lane findings (node M1)

> 2026-10-19. Tests: Sonnet 5.5, black-box from the spec and the frozen interface (`tempo-interface-v1`), no sight of the implementation. Implementation: Opus, main session, no sight of the tests before the merge. Merge commit `bd507c9`.

## Result

| Suite | Count | Result before fixes | Result after fixes |
|---|---|---|---|
| Unit (`test/unit/`) | 97 + 1 harness self-test | 2 failed | all pass |
| Smoke (`test/smoke/`, main session) | 5 | all pass | all pass |
| Fork (`FOUNDRY_PROFILE=fork`) | 11 | all pass | all pass |
| `forge coverage` | `src/InvoiceEscrow.sol` 100% lines, `src/InvoiceFactory.sol` 100% lines | | |

Red check on the stubs (test author, before any implementation existed): 97 of 97 unit tests and 11 of 11 fork tests failed; only the harness self-test passed. The test author also validated the suite against a private reference implementation it wrote from the spec, and against about 23 single-line mutations; every mutation was caught by at least one test.

## Findings

| # | Test | Classification | Resolution |
|---|---|---|---|
| 1 | `test_ZeroAddressCaller_TriggerPaymentUnfunded` | **impl bug** | `triggerPayment` accepted `address(0)` as a party on an unfunded invoice, because `msg.sender == _buyer` is true while the buyer is still `address(0)`. It reverted `NotFunded` instead of `NotParty`. Fixed: a zero buyer never counts as a party |
| 2 | `test_ZeroAddressCaller_CannotCancelUnfundedInvoice` | **impl bug** | Same root cause in `cancel`: `address(0)` was authorised to cancel an unfunded invoice. Fixed with the same guard |

Both were missed by the main session's smoke tests. Neither is reachable by a real account (nobody controls `address(0)`), but both contradict spec §3.5/§3.7 ("before funding the buyer is `address(0)`, so only the seller can cancel").

No **test bugs** were found.

## Spec questions raised by the test author

All twelve are consistent with the current implementation and with the tests' stated reading. None caused a failure. They are **spec gaps** (the spec was silent or ambiguous). **Resolved 2026-10-19:** the user approved writing the behaviour into the spec, and it is now in §3.2, §3.3, §3.5 and §3.9.

| Q | Question | Behaviour (implementation = tests) | Spec text written |
|---|---|---|---|
| 1 | `Paid` event when `refund == 0`: which `refundAddress`? | The resolved refund address, `refundToBuyer = 0` | State it in §3.6 |
| 2 | 100% discount: is the zero-value payout transfer made? | Yes, always made (tests accept either) | §3.5: "the seller transfer is always made, even if zero" |
| 3 | `address(0)` calls `triggerPayment` on an unfunded invoice | `NotParty` | Covered by finding 1; §3.5 check order |
| 4 | Accepted tier values | Past cutoffs, `discountBps == 0` and non-monotonic discounts are all accepted | §3.5: "only cutoff order, the due-date bound and the 10,000 cap are checked" |
| 5 | Self-dealing addresses (refund = seller, payout = buyer) | Allowed | §3.5 |
| 6 | Per-tier checks: interleaved or three passes | Interleaved, per tier, in the order in the NatSpec | Already in the NatSpec; add to §3.5 |
| 7 | `fund`/`triggerPayment`/`cancel`/`getInvoice` on the implementation | Unspecified, untested | §3.5: "behaviour on the implementation itself is undefined; it holds no funds" |
| 8 | Non-UTF-8 or unpadded `invoiceRef` | Accepted byte for byte; only `bytes32(0)` rejected | §3.2 |
| 9 | `NotFactory` vs `AlreadyInitialized` order | `NotFactory` first | Already in the NatSpec and S2 |
| 10 | Reentrancy | Not testable (no receive hooks); state rollback on failed transfer is tested | None |
| 11 | Defaults stored as zero | Storage detail, only observable behaviour asserted | None |
| 12 | Token-prefixed payout/refund address | The token's transfer reverts; with a zero discount no refund transfer is made, so a prefixed refund address does not block a no-discount payment | Extend §3.9 |

## Other notes

- **Tier storage.** A Solidity storage array of structs cannot pack, so spec §3.3's "three tiers per slot" is met with a packed `uint80[]`. The fork gas numbers confirm it: `createInvoice` costs 1.86M gas with 0 tiers, 2.37M with 3 (+2 fresh slots) and 3.14M with 10 (+5 fresh slots).
- **Factory ABI.** The factory ABI gained `FailedDeployment` and `InsufficientBalance` from OpenZeppelin `Clones`. The user approved a new tag, `tempo-interface-v1.1`.
- **Test-author process.** The test worktree started at the wrong commit (the Stellar prototype); the agent reset its own branch to `tempo-interface-v1` and looked at nothing else. The branch changes only files under `tempo/contracts/test/`.

## Summary

| Class | Count |
|---|---|
| Impl bug | 2 (one root cause) |
| Test bug | 0 |
| Spec gap | 12 questions, 0 failures, all resolved in the spec |

The independent tests caught 2 implementation bugs that the main session's smoke tests missed, from a spec-only reading and a stub-only interface.

---

# MPP pay-now: `settleDirect` (node M1 of [`mpp-pay-now-dag.md`](mpp-pay-now-dag.md))

> 2026-10-19. Tests: Sonnet 5.5, black-box from MPP spec §3 and §6.1 and the frozen interface (`tempo-interface-v2`). Implementation: Opus, main session, written while the tests were being written, with no sight of them. Merge commit `bb2e755`.

## Result

| Suite | Count | Result before fixes | Result after fixes |
|---|---|---|---|
| `test/unit/InvoiceEscrowSettleDirect.t.sol` | 37 (8 from spec §6.1 + 29 boundary/adversarial) | all pass | no fixes needed |
| Rest of unit + smoke (incl. 2 main-session `settleDirect` smoke tests) | 105 | all pass | |

Red check on the stub (test author): 37 of 37 failed. The test author also ran the suite against its own throw-away reference implementation (all passed) and reverted it.

## Findings

None. No implementation bugs, no test bugs. This is a smaller surface than v1 (one function, three checks), and the spec spelled out check order and rounding, which left little room for the two readings to diverge.

## Spec questions raised by the test author

All five match the implementation and the spec. None caused a failure, and none needs a spec change:

| # | Question | Assessment |
|---|---|---|
| 1 | Does the payout address or payer get the seller's underpayment override? | No. Spec §3.1 says "only the seller may do it" |
| 2 | Is there a due-date check? | No. After the last cutoff the discount is 0, so `due == principal`. Spec §3.1 has no such check |
| 3 | Check order | Pinned by both the spec and the NatSpec |
| 4 | Other events besides `SettledDirect` (no `Paid`, one memo transfer) | Implied by §3.1, which lists one transfer and one event |
| 5 | Funds sent into a non-Active clone stay stuck | Spec §7, by design |

## Other notes

- **Test-author process, again.** The worktree started at `f637c0d`, not at the tag. The agent reset its branch to `tempo-interface-v2`, as in v1. The Agent tool's worktree evidently branches from somewhere other than the current HEAD, so future briefs should say "reset to the tag first".
- **Fork suite.** The test author reported that the fork suite's `setUp` now fails because the Moderato fork holder's token balance is too low. That needs testnet funds (`cast rpc tempo_fundAddress`), not a code change, and `settleDirect` doesn't touch it.

## Summary

| Class | Count |
|---|---|
| Impl bug | 0 |
| Test bug | 0 |
| Spec gap | 5 questions, 0 failures, none needing a spec change |
