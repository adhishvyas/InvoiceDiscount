# Spec questions raised by the test lane (Ethereum)

Each open question is marked `// SPEC-QUESTION n` at the test that depends on it. For every one, the test encodes the
reading listed under "Assumed".

| # | Question | Assumed (what the test asserts) | Where |
|---|---|---|---|
| 1 | Order of logs inside one call. Spec 3.5 lists the token call first and then "Emits ...". Is the ERC-20 `Transfer` log guaranteed to precede the escrow event (`Funded`, `Paid`, `Cancelled`, `SettledDirect`)? `vm.expectEmit` is order-sensitive across emitters, so the tests cannot avoid taking a side. | `Transfer` log(s) first, escrow event last. For `triggerPayment`: payout `Transfer`, then refund `Transfer`, then `Paid`. | `InvoiceEscrow.t.sol::test_EventsCarryInvoiceRef`, `_expectSettled` in `InvoiceEscrowSettleDirect.t.sol`, and the Transfer-then-event expectations elsewhere; the fork lifecycle |
| 2 | Spec 3.5 says a non-ERC-20 contract "makes `fund` revert, so no funds can be locked against it". `SafeERC20` treats a call that succeeds with empty return data to an address with code as success. So a contract with a permissive `fallback()` (or one that implements `transferFrom` with no return value but does nothing) makes `fund` succeed with the escrow marked `Funded` and no tokens moved. The claim holds only for contracts that revert on unknown selectors. | Only the claim as written is tested, with contracts that have no fallback (the factory, the implementation): creation succeeds, `fund` reverts with empty revert data (`expectRevert(bytes(""))`), state unchanged. The permissive-fallback case is not asserted either way. Suggest softening the sentence in 3.5, or documenting this in 3.9. | `InvoiceEscrow.t.sol::test_AnyContractAcceptedAsToken_NonERC20FundReverts` |
| 3 | Tokens sent to an Active clone that is then funded in the normal way: spec 3.9 only covers strays in a non-Active clone. Does `triggerPayment` split only `principal` (stray amount stays), or the whole balance? Spec 3.5 amounts are `principal`-based. | `principal` only; the stray amount stays in the clone, for `triggerPayment` and for `cancel`. | `InvoiceEscrowTokens.t.sol::test_StrayTokensBeforeFunding_StayInEscrowAfterPayment`, `test_StrayTokensInFundedClone_CancelRefundsOnlyPrincipal` |

## Carried over from Tempo, now closed

All twelve Tempo questions (`tempo/contracts/test/SPEC_QUESTIONS.md`) and the five MPP questions were resolved in the
Tempo spec and are repeated in the Ethereum spec, so they are not marked `SPEC-QUESTION` here (the ported tests keep a
plain comment naming the Tempo question). Dispositions:

| Tempo Q | Reading used |
|---|---|
| 1 | `Paid` carries the resolved refund address even when `refundToBuyer == 0` (spec 3.6) |
| 2 | The zero-amount payout transfer is **always made**, even at a 100% discount (spec 3.5). The Tempo test accepted either; the Ethereum test requires a `Transfer(escrow, payout, 0)` |
| 3 | `address(0)` is never a party: `NotParty` from `triggerPayment`, `NotAuthorizedToCancel` from `cancel` |
| 4 | Past cutoffs, zero-bps tiers, non-monotonic bps accepted |
| 5 | Self-dealing payout/refund addresses allowed |
| 6 | Per-tier checks are one interleaved pass (NatSpec) |
| 7 | Behaviour on the implementation or an uninitialised clone: not tested (spec: undefined). Only `initialize` on the implementation is tested |
| 8 | Any non-zero `bytes32` reference accepted, carried byte for byte (now in the `invoiceRef` topic) |
| 9 | `NotFactory` before `AlreadyInitialized` before argument validation |
| 10 | Reentrancy: testable on Ethereum. `test_ReentrantTokenCannotDoubleSpend*` (see below) |
| 11 | Defaults stored as zero: only observable behaviour is asserted |
| 12 | Token-prefixed payout/refund addresses (Tempo only) became a **blocklist** mock (`MockToken.setBlocked`): a blocked payout, refund or buyer address makes the transfer revert with the token's own error, unchanged; nothing partial remains; with no discount no refund transfer is made, so a blocked refund address does not stop a full-price payment |
| MPP 1-5 | Unchanged (`settleDirect` underpayment override is seller-only, no due-date check, check order `NotActive` > `NothingToSettle` > `InsufficientDirectPayment`, `SettledDirect` only, no `Paid`) |

## Ethereum-specific choices (not ambiguities)

- **Tempo's `NotTIP20` cases.** An EOA, `address(0)`, `address(0xBEEF)`, `address(0x01)` (a precompile with no code) give
  `InvalidToken`. The Tempo cases for a real contract (the factory, the DEX precompile) now go the other way: the check
  is `code.length > 0`, so the factory and the escrow implementation are accepted as a token at creation (question 2).
- **Reentrancy design.** An ERC-20 callback runs with `msg.sender == token`, so a re-entered call would revert with
  `NotParty` / `NotAuthorizedToCancel` regardless of the status ordering, which would prove nothing. `ReentrantToken` can
  therefore act as a wallet (`exec`): it is made the seller (via the factory) or the buyer (via `fund`), so the
  re-entered call passes authorisation and only the status guard stops it. The callback fires after the balances move
  (like a recipient hook). Each of `triggerPayment`, `cancel`, `settleDirect` and `fund` is attacked during each of the
  four entry points where it applies. The inner revert data must be exactly the function's status error
  (`NotFunded`, `AlreadySettled`, `NotActive`, `NotActive`); for the one inner `cancel` made by a buyer before the due
  date it is `NotAuthorizedToCancel`. Moving any `status =` line after its token call makes these tests fail.
- **Gas snapshot.** `vm.snapshotGasLastCall` writes to `snapshots/`, outside `test/`, so the fork tests measure with
  `gasleft()` and `console.log` the numbers (use `-vv`). They assert only a loose upper bound and that more tiers cost
  more gas.
- **Mocks.** `MockERC20` (6 decimals) and `MockERC20D18` share a base with `mint`, a global `setPaused` and a per-address
  `setBlocked`; these stand in for the issuer controls of spec 3.9. `NoReturnToken` returns nothing from `transfer`,
  `transferFrom` and `approve`. `FalseReturnToken` returns `false` while `failing` is true (the default) and behaves
  normally after `setFailing(false)`, so it can fund an invoice and then fail the payout. Error selectors for plain
  allowance and balance failures are OpenZeppelin's `ERC20InsufficientAllowance` / `ERC20InsufficientBalance`, with
  arguments, which bubble through `SafeERC20` unchanged.

## Red check

`forge test --match-path 'test/unit/*'` against the stubs: 148 of 154 fail. The 6 that pass are the harness self-tests
`BaseSelfTest::test_Harness_*` in `test/unit/Base.t.sol`. They exercise only the mocks (mint, approve, transfer,
pause, blocklist, 18 decimals, no-return and false-return behaviour, the reentrancy hook) and never call the factory's
`createInvoice` or the escrow. The fork suite (11 tests) is red against the stubs.

## Validation of the tests themselves

The suite was run against a private, throw-away reference implementation written from the spec (kept outside the repo,
never committed): all 154 unit tests and all 11 fork tests pass against it. Single-line mutations of that reference,
each caught by at least one test: status update moved after the token call in `triggerPayment`, `cancel`, `settleDirect`
and `fund` (caught by the reentrancy tests), `safeTransferFrom` replaced by a plain `transferFrom` (no-return and
false-return tests), a zero `invoiceRef` in an event, skipping the zero-amount payout transfer, rounding the refund up,
dropping the token code check, letting `address(0)` act as the buyer, and removing the seller-only underpayment
override.
