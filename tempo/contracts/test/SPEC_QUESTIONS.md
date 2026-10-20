# Spec questions raised by the test lane

Each question is marked `// SPEC-QUESTION n` at the test that depends on it. For every one, the test encodes the reading
listed under "Assumed".

| # | Question | Assumed (what the test asserts) | Where |
|---|---|---|---|
| 1 | `Paid(caller, payoutAddress, toSeller, refundAddress, refundToBuyer, discountBps)`: when `refund == 0` (no discount), is `refundAddress` still the resolved refund address, or `address(0)`? Spec 3.5 says `_refund()` is emitted; the NatSpec agrees but never addresses the zero-refund case. | Resolved address is always emitted (e.g. the buyer), `refundToBuyer = 0`, `discountBps = 0`. | `InvoiceEscrowEdge.t.sol::test_Event_Paid_NoDiscount_AddressesStillResolved` |
| 2 | 100% discount makes `toSeller == 0`. Spec 3.5 skips the transfer only for `refund == 0`; it says nothing about skipping a zero `toSeller` transfer. Is a zero-value payout transfer made or skipped? The verification notes show TIP-20 accepts 0-amount memo transfers. | Both are acceptable. The test asserts the payment succeeds, the refund address gets the full principal with the memo, `Paid(.., toSeller = 0, .., refund = principal, 10_000)` is emitted, and IF a payout transfer is logged it has amount 0. | `test_FullDiscount_SellerGetsZero` |
| 3 | `address(0)` as caller of `triggerPayment` on an unfunded invoice: `buyer == address(0)` until funded. Strictly the caller is neither seller nor buyer, so `NotParty`; a naive `msg.sender == buyer` comparison would let address(0) pass `NotParty` and fail on `NotFunded`. | `NotParty`. (The cancel analogue is explicit in spec 3.5, so `cancel` by `address(0)` on an unfunded invoice after the due date must be `NotAuthorizedToCancel`; that one is not a question.) | `test_ZeroAddressCaller_TriggerPaymentUnfunded`, `test_ZeroAddressCaller_CannotCancelUnfundedInvoice` |
| 4 | Tier values the spec never forbids: a `cutoff` already in the past (only `> 0`, strictly ascending, `<= dueDate` are required), `discountBps == 0`, and non-monotonic discounts (a later tier with a bigger discount). | All accepted; `activeDiscount` is purely "first tier with `timestamp < cutoff`". | `test_TierCutoffInThePastIsAllowed_NonMonotonicBpsAllowed`, `test_ZeroBpsTier_NoRefund` |
| 5 | Self-dealing addresses: refund address equal to the seller, payout address equal to the (future) buyer. Spec only blocks the seller from funding. | Allowed; money goes where the addresses say. | `test_SelfDealingAddressesAllowed` |
| 6 | Order of the per-tier checks across several tiers. NatSpec: "for each tier, in order, and for each tier in this order: ascending, after-due-date, too-large". Is that one pass applying all three checks to tier 0, then tier 1 (interleaved), or three separate passes? | One interleaved pass: tier 0's error wins even if tier 1 would fail an earlier-listed check. | `InvoiceFactory.t.sol::test_ValidationOrder_TierChecksAreInterleavedPerTier` |
| 7 | Behaviour of `fund` / `triggerPayment` / `cancel` / `getInvoice` on the implementation contract or on an uninitialised clone (seller, token and principal are zero, status defaults to `Active`). Unspecified. | Not tested (only that `initialize` cannot be called on the implementation by anyone). An implementation should make these revert or be harmless; recommend marking this in the spec. | n/a |
| 8 | `invoiceRef` content: spec 3.2 says UTF-8, at most 32 bytes, but only `bytes32(0)` is rejected on-chain. Invalid UTF-8 or non-padded values (e.g. `bytes32(uint256(1))`, `0xff..ff`) are accepted? | Accepted, stored byte-for-byte, used unchanged as the memo. | `test_GetInvoice_NonAsciiAndOddReferences` |
| 9 | Order of `NotFactory` and `AlreadyInitialized`. Spec 3.5 lists `AlreadyInitialized` first among the validations and says nothing about `NotFactory`'s rank. The NatSpec fixes it: `NotFactory` first. | `NotFactory` first, then `AlreadyInitialized`, then argument validation. | `test_InitializeOnlyOnceAndOnlyFactory`, `test_Initialize_*` |
| 10 | Reentrancy: TIP-20 has no receive hooks, so the escrow cannot be re-entered through a token transfer and the "status before transfers" ordering (spec 3.5) is not observable from the external interface. | Not directly testable. Indirectly covered: when the token call reverts (paused token, token-prefixed recipient) the whole call reverts, status stays `Funded`/`Active` and no partial transfer remains. | `test_PausedToken_*`, `test_TokenPrefixed*` |
| 11 | Whether `payoutAddress == seller` / `refundAddress == buyer` is stored as zero (spec 3.5) is a storage detail. | Only the observable behaviour is asserted: `getInvoice` and the money flow are identical to passing `address(0)`. | `test_PayoutEqualToSeller_SameAsDefault`, `test_RefundEqualToBuyer_SameAsDefault` |
| 12 | Spec 3.9 ("TIP-20-prefixed recipients") says a payout/refund address that is a token address makes `triggerPayment` / `cancel` revert and funds stay in escrow, not checked in code. The test asserts the revert comes from the token (`InvalidRecipient`) and that nothing partial remains. Note this also means: with a zero discount no refund transfer is made, so a token-prefixed *refund* address does not block a no-discount payment. | As described. | `test_TokenPrefixedPayout_*`, `test_TokenPrefixedRefund_*` |

## Red check

`forge test --match-path 'test/unit/*'` against the stubs: the only passing test is the harness self-test
`BaseSelfTest::test_Harness_MintApproveAndMemoTransfer` (it never touches the stubbed functions; it checks the
harness's real TIP-20 token, `isTIP20` answers for the unprefixed and prefixed-without-code addresses, and the real
`TransferWithMemo` events).

## Validation of the tests themselves

The suite was also run against a private, throw-away reference implementation (kept outside the repo, never
committed) written from the spec: all tests passed, and 20+ single-line mutations (flipped boundaries, removed checks,
wrong memo, wrong refund destination, missing `if (refund > 0)`, rounding errors, ...) each made at least one test
fail. Two tests (`test_ZeroAddressCaller_*`) fail against the naive `msg.sender == buyer` implementation on purpose.

## MPP pay-now (settleDirect)

Marked `// SPEC-QUESTION n` in `test/unit/InvoiceEscrowSettleDirect.t.sol`. Numbering restarts here.

1. Is the payout address (or the buyer/payer) allowed the seller's underpayment override? Spec 3.1 and the NatSpec say only `msg.sender == seller`. Assumed: no. A non-seller payout address with `balance < due` gets `InsufficientDirectPayment`. Test: `test_BuyerAndPayoutAreNotSpecialCallers`.
2. Does `settleDirect` care about the due date? Neither spec nor NatSpec has a due-date check, and the discount is 0 after the last cutoff. Assumed: it works after the due date at the full-principal price (`due == principal`). Test: `test_DueDatePassed_SettleStillWorksAtFullPrice`.
3. (No marker.) The spec's bullet order and the NatSpec's "Checks, in order" agree. The tests pin that order: `NotActive` beats `NothingToSettle` beats `InsufficientDirectPayment` (`test_NotActiveWinsOverNothingToSettle`, `test_NothingToSettleWinsOverInsufficient`).
4. (No marker.) The spec is silent on which events the clone emits besides `SettledDirect`. Assumed: no `Paid`, and exactly one memo transfer (`test_SettledDirectEvent_EmittedOnceWithCallerPayoutAmountBps`, `test_MemoTransferLog_Arguments`).
5. (No marker.) Funds sent into a Cancelled/Funded/Paid clone stay stuck (spec 7). The tests assert `settleDirect` reverts `NotActive` and the balance is untouched.

## Red check (settleDirect)

Against the v2 stub every test in `InvoiceEscrowSettleDirect.t.sol` fails (37 of 37; the stub reverts with `Error(string)`, which no `expectRevert(selector)` accepts). Against a throw-away reference implementation written from the spec (not committed) all 37 pass.
