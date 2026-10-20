// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";

/// @notice Black-box tests for `InvoiceEscrow.settleDirect()` (MPP pay-now spec section 3 and 6.1).
contract InvoiceEscrowSettleDirectTest is Base {
    uint256 internal constant DUE_15 = 85_000e6; // PRINCIPAL less 15%
    uint256 internal constant DUE_10 = 90_000e6; // PRINCIPAL less 10%

    // ───────────── helpers ─────────────

    /// @dev Transfer tokens straight into the clone, as the MPP buyer does.
    function _payIn(InvoiceEscrow inv, address from, uint256 amount) internal {
        vm.prank(from);
        token.transfer(address(inv), amount);
    }

    function _settleAs(InvoiceEscrow inv, address who) internal {
        vm.prank(who);
        inv.settleDirect();
    }

    function _expectInsufficient(uint256 balance, uint256 due) internal {
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, balance, due));
    }

    /// @dev Expect, in order: token Transfer, TransferWithMemo(clone -> to, amount, REF), SettledDirect.
    function _expectSettled(InvoiceEscrow inv, address caller, address to, uint256 amount, uint16 bps) internal {
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(inv), to, amount);
        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(address(inv), to, amount, REF);
        vm.expectEmit(true, false, false, true, address(inv));
        emit SettledDirect(caller, to, amount, bps);
    }

    function _oneTier(uint64 cutoff, uint16 bps) internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](1);
        t[0] = DiscountTier({cutoff: cutoff, discountBps: bps});
    }

    // ───────────── spec 6.1 ─────────────

    function test_SettleDirectExactAmount() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, DUE_15);
        uint256 payoutBefore = _bal(payout);
        uint256 sellerBefore = _bal(seller);

        _expectSettled(inv, stranger, payout, DUE_15, 1500);
        _settleAs(inv, stranger);

        assertEq(_bal(payout), payoutBefore + DUE_15);
        assertEq(_bal(seller), sellerBefore);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_SettleDirectOverpaymentGoesToSeller() public {
        InvoiceEscrow inv = _createDefault();
        uint256 paid = DUE_15 + 12_345e6;
        _payIn(inv, buyer, paid);
        uint256 sellerBefore = _bal(seller);

        _expectSettled(inv, stranger, seller, paid, 1500);
        _settleAs(inv, stranger);

        assertEq(_bal(seller), sellerBefore + paid);
        assertEq(_bal(address(inv)), 0);
    }

    function test_SettleDirectUnderpaymentReverts() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15 - 1e6);

        _expectInsufficient(DUE_15 - 1e6, DUE_15);
        _settleAs(inv, stranger);

        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));
        assertEq(_bal(address(inv)), DUE_15 - 1e6);
    }

    function test_SettleDirectSellerAcceptsUnderpayment() public {
        InvoiceEscrow inv = _createWithPayout();
        uint256 paid = DUE_15 - 7e6;
        _payIn(inv, buyer, paid);
        uint256 payoutBefore = _bal(payout);

        _expectSettled(inv, seller, payout, paid, 1500);
        _settleAs(inv, seller);

        assertEq(_bal(payout), payoutBefore + paid);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_SettleDirectNothingToSettle() public {
        InvoiceEscrow inv = _createDefault();

        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, seller);

        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, stranger);

        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, buyer);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));
    }

    function test_SettleDirectOnlyWhenActive() public {
        // Funded (the clone holds the principal, so a naive balance check would pass).
        InvoiceEscrow funded = _createDefault();
        _fund(funded, address(0));
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(funded, stranger);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(funded, seller);

        // Paid via the fund -> triggerPayment path.
        InvoiceEscrow paid = _createDefault();
        _fund(paid, address(0));
        vm.prank(seller);
        paid.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(paid, stranger);

        // Paid via settleDirect.
        InvoiceEscrow direct = _createDefault();
        _payIn(direct, buyer, DUE_15);
        _settleAs(direct, stranger);
        _payIn(direct, buyer, 1e6);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(direct, stranger);

        // Cancelled while funded.
        InvoiceEscrow cancelled = _createDefault();
        _fund(cancelled, address(0));
        vm.prank(seller);
        cancelled.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(cancelled, stranger);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(cancelled, seller);
    }

    function test_FundAfterSettleDirectReverts() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        _settleAs(inv, stranger);

        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        inv.fund(address(0));
        vm.stopPrank();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_SettleDirectTierBoundary() public {
        InvoiceEscrow inv = _createDefault();
        // Quote window minimum: the 10% tier price (the day-15 cutoff falls inside the quote window).
        vm.warp(T0 + 15 * DAY - 60);
        assertEq(inv.activeDiscount(uint64(block.timestamp)), 1500);
        _payIn(inv, buyer, DUE_10);

        // The cutoff passes before settleDirect runs.
        vm.warp(T0 + 15 * DAY + 30);
        _expectSettled(inv, stranger, seller, DUE_10, 1000);
        _settleAs(inv, stranger);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    // ───────────── boundaries ─────────────

    function test_DueMinusOneReverts_ThenTopUpSettles_NonSeller() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15 - 1);
        _expectInsufficient(DUE_15 - 1, DUE_15);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, DUE_15, 1500);
        _settleAs(inv, stranger);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        assertEq(_bal(address(inv)), 0);
    }

    function test_BuyerAndPayoutAreNotSpecialCallers() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, DUE_15 - 1);
        _expectInsufficient(DUE_15 - 1, DUE_15);
        _settleAs(inv, buyer);
        // SPEC-QUESTION 1: the payout address is not the seller, so it gets no underpayment override.
        _expectInsufficient(DUE_15 - 1, DUE_15);
        _settleAs(inv, payout);
    }

    function test_ZeroBps_NoTiers_FullPrincipalDue() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _noTiers(), address(0));
        _payIn(inv, buyer, PRINCIPAL - 1);
        _expectInsufficient(PRINCIPAL - 1, PRINCIPAL);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, PRINCIPAL, 0);
        _settleAs(inv, stranger);
    }

    function test_ZeroBps_AfterLastCutoff() public {
        InvoiceEscrow inv = _createDefault();
        vm.warp(T0 + 30 * DAY); // exactly the last cutoff: no tier applies
        assertEq(inv.activeDiscount(uint64(block.timestamp)), 0);
        _payIn(inv, buyer, PRINCIPAL - 1);
        _expectInsufficient(PRINCIPAL - 1, PRINCIPAL);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, PRINCIPAL, 0);
        _settleAs(inv, stranger);
    }

    function test_TierBoundary_ExactlyAtCutoffTierNoLongerApplies() public {
        InvoiceEscrow inv = _createDefault();
        vm.warp(T0 + 15 * DAY); // block.timestamp == cutoff of the 15% tier: the 10% tier applies
        _payIn(inv, buyer, DUE_15);
        _expectInsufficient(DUE_15, DUE_10);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, DUE_10 - DUE_15);
        _expectSettled(inv, stranger, seller, DUE_10, 1000);
        _settleAs(inv, stranger);
    }

    function test_TierBoundary_OneSecondBeforeCutoffTierApplies() public {
        InvoiceEscrow inv = _createDefault();
        vm.warp(T0 + 15 * DAY - 1);
        _payIn(inv, buyer, DUE_15);
        _expectSettled(inv, stranger, seller, DUE_15, 1500);
        _settleAs(inv, stranger);
    }

    function test_FullDiscount_DueIsZero_AnyPositiveBalanceSettlesForStranger() public {
        DiscountTier[] memory t = _oneTier(T0 + uint64(DAY), 10_000);
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), t, payout);
        _payIn(inv, buyer, 1);
        uint256 payoutBefore = _bal(payout);

        _expectSettled(inv, stranger, payout, 1, 10_000);
        _settleAs(inv, stranger);
        assertEq(_bal(payout), payoutBefore + 1);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_FullDiscount_ZeroBalanceStillNothingToSettle() public {
        DiscountTier[] memory t = _oneTier(T0 + uint64(DAY), 10_000);
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), t, address(0));
        // due == 0 must not let a zero balance through.
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, stranger);
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, seller);
    }

    function test_OddPrincipal_DiscountFlooredSellerGetsRemainder() public {
        uint128 principal = 1_000_001; // 15% = 150000.15 -> 150000 floored, due = 850001
        InvoiceEscrow inv = _create(seller, REF, address(token), principal, _dueDate(), _defaultTiers(), address(0));
        _payIn(inv, buyer, 850_000);
        _expectInsufficient(850_000, 850_001);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, 850_001, 1500);
        _settleAs(inv, stranger);
    }

    function test_OddPrincipal_TinyPrincipalDiscountRoundsToZero() public {
        // principal 3, 15%: floor(0.45) = 0, so due == 3.
        InvoiceEscrow inv = _create(seller, REF, address(token), 3, _dueDate(), _defaultTiers(), address(0));
        _payIn(inv, buyer, 2);
        _expectInsufficient(2, 3);
        _settleAs(inv, stranger);
        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, 3, 1500);
        _settleAs(inv, stranger);
    }

    // ───────────── seller override ─────────────

    function test_SellerOverpayment_ForwardsWholeBalance() public {
        InvoiceEscrow inv = _createDefault();
        uint256 paid = DUE_15 + 1;
        _payIn(inv, buyer, paid);
        uint256 sellerBefore = _bal(seller);
        _expectSettled(inv, seller, seller, paid, 1500);
        _settleAs(inv, seller);
        assertEq(_bal(seller), sellerBefore + paid);
    }

    function test_SellerOneUnitBalance_Settles() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, 1);
        _expectSettled(inv, seller, payout, 1, 1500);
        _settleAs(inv, seller);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    // ───────────── event / memo details ─────────────

    function test_MemoTransferLog_Arguments() public {
        InvoiceEscrow inv = _createWithPayout();
        uint256 paid = DUE_15 + 5;
        _payIn(inv, buyer, paid);

        vm.recordLogs();
        _settleAs(inv, stranger);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        MemoLog[] memory memos = _memoLogs(logs);
        assertEq(memos.length, 1, "exactly one memo transfer");
        assertEq(memos[0].from, address(inv));
        assertEq(memos[0].to, payout);
        assertEq(memos[0].amount, paid);
        assertEq(memos[0].memo, REF);
    }

    function test_SettledDirectEvent_EmittedOnceWithCallerPayoutAmountBps() public {
        InvoiceEscrow inv = _createWithPayout();
        uint256 paid = DUE_15 + 5;
        _payIn(inv, buyer, paid);

        vm.recordLogs();
        _settleAs(inv, stranger);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(inv)) {
                n++;
                assertEq(logs[i].topics[0], SettledDirect.selector);
                assertEq(address(uint160(uint256(logs[i].topics[1]))), stranger);
                (address p, uint256 amt, uint16 bps) = abi.decode(logs[i].data, (address, uint256, uint16));
                assertEq(p, payout);
                assertEq(amt, paid);
                assertEq(bps, 1500);
            }
        }
        assertEq(n, 1, "SettledDirect only, no Paid");
    }

    function test_PayoutResolution_NoPayoutAddressGoesToSeller() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        uint256 sellerBefore = _bal(seller);

        vm.recordLogs();
        _settleAs(inv, stranger);
        MemoLog[] memory memos = _memoLogs(vm.getRecordedLogs());

        assertEq(memos.length, 1);
        assertEq(memos[0].to, seller);
        assertEq(_bal(seller), sellerBefore + DUE_15);
    }

    function test_PayoutEqualsSeller_SameAsDefault() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), seller);
        _payIn(inv, buyer, DUE_15);
        _expectSettled(inv, stranger, seller, DUE_15, 1500);
        _settleAs(inv, stranger);
    }

    function test_PayoutAddressIsCaller_StillReceivesFunds() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, DUE_15);
        uint256 before = _bal(payout);
        _expectSettled(inv, payout, payout, DUE_15, 1500);
        _settleAs(inv, payout);
        assertEq(_bal(payout), before + DUE_15);
    }

    function test_SellerIsCaller_PayoutElsewhere_PayoutGetsFunds() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, DUE_15);
        uint256 sellerBefore = _bal(seller);
        uint256 payoutBefore = _bal(payout);
        _settleAs(inv, seller);
        assertEq(_bal(seller), sellerBefore);
        assertEq(_bal(payout), payoutBefore + DUE_15);
    }

    // ───────────── post-state ─────────────

    function test_GetInvoiceAfterSettle_PaidBuyerAndRefundStayZero() public {
        InvoiceEscrow inv = _createWithPayout();
        _payIn(inv, buyer, DUE_15);
        InvoiceState memory before = inv.getInvoice();
        _settleAs(inv, stranger);
        InvoiceState memory s = inv.getInvoice();

        assertEq(uint8(s.status), uint8(Status.Paid));
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, payout);
        assertEq(s.invoiceRef, REF);
        assertEq(s.token, address(token));
        assertEq(s.principal, PRINCIPAL);
        assertEq(s.dueDate, before.dueDate);
        assertEq(s.tiers.length, 2);
        assertEq(s.tiers[0].cutoff, before.tiers[0].cutoff);
        assertEq(s.tiers[0].discountBps, 1500);
    }

    function test_CloneBalanceZeroAfterSettle_NoTokensCreatedOrLost() public {
        InvoiceEscrow inv = _createWithPayout();
        uint256 paid = DUE_15 + 777;
        _payIn(inv, buyer, paid);
        Bals memory b0 = _snap(address(inv));
        _settleAs(inv, stranger);
        Bals memory b1 = _snap(address(inv));

        assertEq(b1.escrow, 0);
        assertEq(_total(b1), _total(b0));
        assertEq(b1.payout, b0.payout + paid);
        assertEq(b1.buyer, b0.buyer);
        assertEq(b1.refund, b0.refund);
        assertEq(b1.stranger, b0.stranger);
    }

    function test_SettleDirectTwice_SecondRevertsNotActive() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        _settleAs(inv, stranger);

        _payIn(inv, buyer, DUE_15); // stray funds after settling
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, stranger);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, seller);
        assertEq(_bal(address(inv)), DUE_15);
    }

    function test_NotActiveWinsOverNothingToSettle() public {
        // Cancelled Active invoice with an empty clone: NotActive, not NothingToSettle.
        InvoiceEscrow inv = _createDefault();
        vm.prank(seller);
        inv.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, seller);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, stranger);
    }

    function test_NothingToSettleWinsOverInsufficient() public {
        // balance 0 with due > 0 and a non-seller caller: NothingToSettle, not InsufficientDirectPayment.
        InvoiceEscrow inv = _createDefault();
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        _settleAs(inv, stranger);
    }

    function test_CancelledActiveInvoiceWithStrayFunds_CannotSettle() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        vm.prank(seller);
        inv.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, seller);
        assertEq(_bal(address(inv)), DUE_15);
    }

    function test_DueDatePassed_SettleStillWorksAtFullPrice() public {
        // SPEC-QUESTION 2: settleDirect has no due-date check; after the due date the discount is 0.
        InvoiceEscrow inv = _createDefault();
        vm.warp(uint256(_dueDate()) + 1);
        _payIn(inv, buyer, PRINCIPAL - 1);
        _expectInsufficient(PRINCIPAL - 1, PRINCIPAL);
        _settleAs(inv, stranger);
        _payIn(inv, buyer, 1);
        _expectSettled(inv, stranger, seller, PRINCIPAL, 0);
        _settleAs(inv, stranger);
    }

    // ───────────── interaction with the other paths ─────────────

    function test_TriggerPaymentAfterSettleDirect_Reverts() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        _settleAs(inv, stranger);

        // Seller is a party, status is Paid: NotFunded. A non-party hits NotParty first.
        vm.prank(seller);
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        inv.triggerPayment();

        vm.prank(stranger);
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        inv.triggerPayment();

        vm.prank(buyer); // never recorded as buyer
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        inv.triggerPayment();
    }

    function test_CancelAfterSettleDirect_Reverts() public {
        InvoiceEscrow inv = _createDefault();
        _payIn(inv, buyer, DUE_15);
        _settleAs(inv, stranger);

        vm.prank(seller);
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        inv.cancel();

        // Even after the due date nobody but the seller is authorised (buyer is address(0)).
        vm.warp(uint256(_dueDate()) + 1);
        vm.prank(seller);
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        inv.cancel();
        vm.prank(buyer);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        inv.cancel();
        vm.prank(address(0));
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        inv.cancel();
    }

    function test_SettleDirectOnFundedInvoiceMovesNothing_NormalPathStillWorks() public {
        InvoiceEscrow inv = _createDefault();
        _fund(inv, refund);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        _settleAs(inv, stranger);
        assertEq(_bal(address(inv)), PRINCIPAL);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_SettleDirectDoesNotAffectOtherInvoices() public {
        InvoiceEscrow a = _createDefault();
        InvoiceEscrow b = _createDefault();
        _payIn(a, buyer, DUE_15);
        _payIn(b, buyer, DUE_15);
        _settleAs(a, stranger);
        assertEq(_bal(address(b)), DUE_15);
        assertEq(uint8(b.getInvoice().status), uint8(Status.Active));
    }
}
