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

## ETH

Ambiguities met while writing the native-ETH tests (interface `ethereum-interface-v2`). Each bullet gives the reading the
test assumes. Tests that depend on one carry a plain reference to it.

- **ETH-1, order of logs.** The NatSpec says the escrow's own event is emitted after the payments, so a deferred
  push logs `PayoutDeferred` before `Paid` / `Cancelled` / `SettledDirect`, and the payout's `PayoutDeferred` comes before the
  refund's. `vm.expectEmit` is order-sensitive, so the tests assert exactly that order.
  (`test_Push_Trigger_BothFail_BothCreditedInOrder`, `test_Push_Trigger_PayoutFails_CreditedAndRefundStillPaid`)
- **ETH-2, `triggerPayment` on the implementation.** NatSpec says it reverts "with its status error", but the
  implementation has no seller or buyer, so any real caller fails `NotParty` (checked first) before `NotFunded`. The test
  accepts either selector and requires a revert. (`test_Impl_TriggerPaymentReverts`)
- **ETH-3, stray ETH followed by `fund`.** ETH received while Active and then overtaken by `fund` stays in the clone
  (spec 3.11); `triggerPayment` splits `principal` only, as for tokens (question 3 above). `fund` itself requires
  `msg.value == principal` whatever the balance. (`test_Eth_StrayEthBeforeFunding_StaysAfterTrigger`)
- **ETH-4, unfunded `cancel` with stray ETH.** "An Active invoice moves no tokens" is read as: the escrow's ETH stays
  where it is, nothing is sent, nothing is deferred. (`test_Eth_Cancel_Unfunded_StrayEthStaysInClone`,
  `test_Eth_Cancel_Unfunded_NoEthMoves`)
- **ETH-5, the 50,000 gas cap.** A value-bearing `CALL` gives the callee its gas argument plus the 2,300 stipend, so the
  recipient is assumed to see at most 52,300 gas and (a cap that is not much lower) more than 45,000. A receiver that
  needs 40,000 must succeed; one that needs 60,000 must be deferred. The exact boundary (50,000 vs 52,300) is not
  asserted. (`test_Push_GasCap_ReceiverSeesAbout50kGas`, `_ReceiverNeedingLessThanCapIsPaid`, `_ReceiverNeedingMoreThanCapIsDeferred`)
- **ETH-6, "no return data copied" is not directly observable.** A black-box test can only show that a recipient that
  reverts with, or returns, 60,000 bytes (the most that fits in the 50k cap) neither breaks the call nor makes the caller
  pay more than a bounded amount of gas (< 400k). A copying implementation would pass this too, since the memory cost of
  60 KB is small; the check is a regression guard, not proof. (`test_Push_Trigger_ReturnBomb*`)
- **ETH-7, caller gas bound.** "The caller's tx doesn't consume more than a bounded amount of gas" with a `GasBurner` is
  asserted as < 400,000 gas for `triggerPayment` (two capped pushes), < 300,000 for `cancel` / `settleDirect`.
  The bounds are loose (an uncapped burner takes ~all the gas). (`test_Push_*CallerGasBounded*`)
- **ETH-8, `withdraw` to `address(0)`.** NatSpec says `address(0)` is not special, so the ETH is sent (burnt) and
  `Withdrawn(account, address(0), amount)` is emitted. (`test_Withdraw_ToZeroAddressIsNotSpecial`)
- **ETH-9, `withdraw` to an all-gas burner.** The recipient burns the forwarded gas; the escrow keeps 1/64, enough to
  revert, so the error is `WithdrawFailed` (not an out-of-gas failure of the whole call). The credit is kept.
  (`test_Withdraw_ToGasBurnerFailsAfterItStopsBurningSucceeds`, `test_Withdraw_FailureKeepsCredit_WithdrawFailed`)
- **ETH-10, `Withdrawn` topics.** Only `account` is indexed; `to` and `amount` are in the data (as declared), and the
  event carries no `invoiceRef`. (all `Withdrawn` expectations use `expectEmit(true, false, false, true)`)
- **ETH-11, zero-value plain call.** A call with empty calldata and no value reaches `receive()` and emits
  `Received(from, ref, 0)` (the event doc says "`amount` may be 0"). It does not create a balance for `settleDirect`.
  (`test_Eth_Receive_ZeroValuePlainCallAccepted`, `test_Eth_SettleDirect_NothingToSettle`)
- **ETH-12, `receive()` check order.** ERC-20 invoice is `NativeNotAccepted` in every status (Funded, Paid), before
  the status check. (`test_Receive_Erc20Invoice_NativeNotAcceptedInEveryStatus`)
- **ETH-13, `fund` check order.** `NotActive`, then `SellerCannotFund`, then `IncorrectValue`; also on ERC-20 invoices
  (`IncorrectValue(sent, 0)`). (`test_Eth_Fund_CheckOrder_*`, `test_Fund_Erc20_*`)
- **ETH-14, credits accumulate.** When one address is both payout and refund and both pushes fail, `owed` is the sum and two
  `PayoutDeferred` events are emitted (one per payment, not one merged). (`test_Push_Trigger_SameAddressForPayoutAndRefund_CreditsAccumulate`)
- **ETH-15, `settleDirect` balance source.** ERC-20 invoices ignore ETH forced into the clone, and ETH invoices ignore
  tokens sent to the clone (`NothingToSettle`). Forced ETH counts whether set with `vm.deal` or a `selfdestruct`
  (a `ForceSend` mock). (`test_Erc20_ForcedEthIsIgnoredBySettleDirect`, `test_Eth_TokensSentToEthInvoiceAreIgnoredBySettleDirect`, `test_Eth_SettleDirect_*Forced*`)
- **ETH-16, reentrancy from a seller calling `fund`.** The re-entered `fund` made by the seller fails `NotActive`
  (not `SellerCannotFund`), by the check order. A re-entered `cancel` made by a buyer before the due date fails
  `NotAuthorizedToCancel` (authorisation is checked before the status), so the refund-during-trigger test expects that; the
  after-due-date variants expect `AlreadySettled`. (`test_Reentrancy_*`)
- **ETH-17, 2,300-gas stipend.** `send` returns false and `transfer` reverts because `receive()` reads storage and emits
  (and a clone adds a delegatecall); the test relies on the spec statement, not on a measured cost.
  (`test_Eth_Receive_TransferAndSendWithStipendFail`)
- **ETH-18, `address(0)` creation.** Existing tests that expected `InvalidToken` for `address(0)` now expect success;
  `InvalidToken` is still asserted for EOAs and `address(0x01)` (no code). `address(1)` / `address(0x01)` are the same address.
  (`test_Eth_Create_*`, edited `InvoiceEscrow.t.sol`, `InvoiceFactory.t.sol`, `InvoiceFork.t.sol`)

## Red check

`forge test` against the `ethereum-interface-v2` stubs: 268 tests (154 existing + 114 new in
`InvoiceEscrowNative.t.sol` (76) and `InvoiceEscrowNativeFailures.t.sol` (38)); 262 fail, 6 pass. The 6 that pass are the
harness self-tests `BaseSelfTest::test_Harness_*` in `test/unit/Base.t.sol`, which exercise only the mocks and never call
the factory's `createInvoice` or the escrow. Every new test fails against the stubs (`unimplemented`). The fork suite is
14 tests (11 existing + `test_Fork_EthLifecycle_CreateFundTrigger`, `test_Fork_EthSettleDirect`,
`test_Fork_Gas_CreateInvoice_Eth`); all red against the stubs.

## Validation of the tests themselves

The suite was run against a private, throw-away reference implementation written from the spec (kept outside the repo,
never committed): all 154 unit tests and all 11 fork tests pass against it. Single-line mutations of that reference,
each caught by at least one test: status update moved after the token call in `triggerPayment`, `cancel`, `settleDirect`
and `fund` (caught by the reentrancy tests), `safeTransferFrom` replaced by a plain `transferFrom` (no-return and
false-return tests), a zero `invoiceRef` in an event, skipping the zero-amount payout transfer, rounding the refund up,
dropping the token code check, letting `address(0)` act as the buyer, and removing the seller-only underpayment
override.

For the ETH tests the same method was repeated with a throw-away reference written from the v2 spec (outside the repo,
not committed): all 268 unit tests and all 14 fork tests pass against it. Mutations caught: uncapped push gas, a capped
`withdraw`, a failed push that reverts, zero-amount sends not skipped, `owed` cleared after the call in `withdraw`,
status written after the pushes in `triggerPayment`, `receive()` without the status check, and a missing `Cancelled`
status on the implementation.
