// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {RejectingReceiver} from "../mocks/RejectingReceiver.sol";
import {GasBurner} from "../mocks/GasBurner.sol";
import {ReturnBomb} from "../mocks/ReturnBomb.sol";
import {GasProbe} from "../mocks/GasProbe.sol";
import {ReentrantReceiver} from "../mocks/ReentrantReceiver.sol";

/// @notice Native-ETH push failures (credit in `owed`, `PayoutDeferred`), the 50_000 gas cap, no return-data copy,
///         reentrancy on every path, and `withdraw` (ETH spec 3.3, 3.4, 3.10).
contract InvoiceEscrowNativeFailuresTest is Base {
    uint256 internal constant SELLER_15 = 8.5 ether;
    uint256 internal constant BUYER_15 = 1.5 ether;
    uint256 internal constant DUE_15 = 8.5 ether;

    // ───────────── recipients that make a push fail ─────────────

    uint256 internal constant KINDS = 5;

    function _kindName(uint256 k) internal pure returns (string memory) {
        if (k == 0) return "RejectingReceiver";
        if (k == 1) return "GasBurner";
        if (k == 2) return "ReturnBomb(revert)";
        if (k == 3) return "GasProbe(needs 60k)";
        return "ReentrantReceiver(rejecting)";
    }

    /// @dev A fresh recipient whose plain ETH receive fails when pushed with at most 50k gas.
    function _bad(uint256 k) internal returns (address) {
        if (k == 0) return address(new RejectingReceiver());
        if (k == 1) return address(new GasBurner());
        if (k == 2) return address(new ReturnBomb());
        if (k == 3) return address(new GasProbe(60_000));
        ReentrantReceiver r = new ReentrantReceiver();
        r.setRejecting(true);
        return address(r);
    }

    /// @dev Funded ETH invoice (default tiers) with the given payout; the buyer funds with `refundAddress`.
    function _funded(address payoutAddress, address refundAddress) internal returns (InvoiceEscrow inv) {
        inv = _createEthWith(payoutAddress, _defaultTiers());
        _fundEth(inv, refundAddress);
    }

    // ═════════════════════════ triggerPayment ═════════════════════════

    function test_Push_Trigger_PayoutFails_CreditedAndRefundStillPaid() public {
        for (uint256 k = 0; k < KINDS; k++) {
            address bad = _bad(k);
            InvoiceEscrow inv = _funded(bad, refund);
            uint256 refundBefore = refund.balance;
            _warpDay(5);

            vm.recordLogs();
            _expectDeferred(inv, bad, SELLER_15);
            _expectPaid(inv, seller, bad, uint128(SELLER_15), refund, uint128(BUYER_15), 1500);
            vm.prank(seller);
            inv.triggerPayment();

            assertEq(inv.owed(bad), SELLER_15, _kindName(k));
            assertEq(bad.balance, 0, _kindName(k));
            assertEq(refund.balance - refundBefore, BUYER_15, "the other party is paid");
            assertEq(inv.owed(refund), 0);
            assertEq(address(inv).balance, SELLER_15, "the deferred amount stays in the escrow");
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
            assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 2, "PayoutDeferred and Paid");
            vm.warp(T0);
        }
    }

    function test_Push_Trigger_RefundFails_CreditedAndPayoutStillPaid() public {
        for (uint256 k = 0; k < KINDS; k++) {
            address bad = _bad(k);
            InvoiceEscrow inv = _funded(payout, bad);
            uint256 payoutBefore = payout.balance;
            _warpDay(5);

            _expectDeferred(inv, bad, BUYER_15);
            _expectPaid(inv, buyer, payout, uint128(SELLER_15), bad, uint128(BUYER_15), 1500);
            vm.prank(buyer);
            inv.triggerPayment();

            assertEq(inv.owed(bad), BUYER_15, _kindName(k));
            assertEq(payout.balance - payoutBefore, SELLER_15);
            assertEq(inv.owed(payout), 0);
            assertEq(address(inv).balance, BUYER_15);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
            vm.warp(T0);
        }
    }

    function test_Push_Trigger_BothFail_BothCreditedInOrder() public {
        for (uint256 k = 0; k < KINDS; k++) {
            address badPayout = _bad(k);
            address badRefund = _bad((k + 1) % KINDS);
            InvoiceEscrow inv = _funded(badPayout, badRefund);
            _warpDay(5);

            vm.recordLogs();
            _expectDeferred(inv, badPayout, SELLER_15); // payout first
            _expectDeferred(inv, badRefund, BUYER_15); // then refund
            _expectPaid(inv, seller, badPayout, uint128(SELLER_15), badRefund, uint128(BUYER_15), 1500);
            vm.prank(seller);
            inv.triggerPayment();

            assertEq(inv.owed(badPayout), SELLER_15);
            assertEq(inv.owed(badRefund), BUYER_15);
            assertEq(address(inv).balance, ETH_PRINCIPAL);
            assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 3);
            vm.warp(T0);
        }
    }

    function test_Push_Trigger_SameAddressForPayoutAndRefund_CreditsAccumulate() public {
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow inv = _funded(address(bad), address(bad));
        _warpDay(5);
        _expectDeferred(inv, address(bad), SELLER_15);
        _expectDeferred(inv, address(bad), BUYER_15);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(bad)), ETH_PRINCIPAL);
    }

    function test_Push_Trigger_FullDiscount_RejectingPayoutZeroAmount_NoCredit() public {
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 10 days, 10_000);
        RejectingReceiver badPayout = new RejectingReceiver();
        InvoiceEscrow inv = _createEthWith(address(badPayout), t);
        _fundEth(inv, refund);
        vm.recordLogs();
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(badPayout)), 0);
        assertEq(refund.balance, ETH_PRINCIPAL);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "Paid only");
    }

    function test_Push_Trigger_CallerGasBoundedWithGasBurners() public {
        GasBurner a = new GasBurner();
        GasBurner b = new GasBurner();
        InvoiceEscrow inv = _funded(address(a), address(b));
        _warpDay(5);
        vm.prank(seller);
        uint256 g0 = gasleft();
        inv.triggerPayment();
        uint256 used = g0 - gasleft();
        // two capped pushes (~52k each) plus the base cost. An uncapped burner would take ~all the gas.
        assertLt(used, 400_000, "the caller's gas use is bounded");
        assertEq(inv.owed(address(a)), SELLER_15);
        assertEq(inv.owed(address(b)), BUYER_15);
    }

    function test_Push_Trigger_ReturnBombRevert_CallerGasBounded_Deferred() public {
        ReturnBomb a = new ReturnBomb(); // reverts with 60,000 bytes
        ReturnBomb b = new ReturnBomb();
        InvoiceEscrow inv = _funded(address(a), address(b));
        _warpDay(5);
        vm.prank(seller);
        uint256 g0 = gasleft();
        inv.triggerPayment();
        uint256 used = g0 - gasleft();
        assertLt(used, 400_000, "revert data of the recipient is not copied");
        assertEq(inv.owed(address(a)), SELLER_15);
        assertEq(inv.owed(address(b)), BUYER_15);
    }

    function test_Push_Trigger_ReturnBombSuccess_PaidDirectlyNoCredit() public {
        ReturnBomb a = new ReturnBomb();
        ReturnBomb b = new ReturnBomb();
        a.setMode(1); // succeeds, returning 60,000 bytes
        b.setMode(1);
        InvoiceEscrow inv = _funded(address(a), address(b));
        _warpDay(5);
        vm.recordLogs();
        vm.prank(seller);
        uint256 g0 = gasleft();
        inv.triggerPayment();
        uint256 used = g0 - gasleft();
        assertLt(used, 400_000, "returned data is not copied");
        assertEq(address(a).balance, SELLER_15);
        assertEq(address(b).balance, BUYER_15);
        assertEq(inv.owed(address(a)), 0);
        assertEq(inv.owed(address(b)), 0);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "Paid only");
        assertEq(address(inv).balance, 0);
    }

    // ═════════════════════════ cancel ═════════════════════════

    function test_Push_Cancel_RefundFails_Credited() public {
        for (uint256 k = 0; k < KINDS; k++) {
            address bad = _bad(k);
            InvoiceEscrow inv = _funded(payout, bad);
            vm.recordLogs();
            _expectDeferred(inv, bad, ETH_PRINCIPAL);
            vm.expectEmit(true, true, false, true, address(inv));
            emit Cancelled(seller, REF, ETH_PRINCIPAL);
            vm.prank(seller);
            inv.cancel();
            assertEq(inv.owed(bad), ETH_PRINCIPAL, _kindName(k));
            assertEq(address(inv).balance, ETH_PRINCIPAL);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
            assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 2);
        }
    }

    function test_Push_Cancel_BuyerAfterDue_RefundFails_Credited() public {
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow inv = _funded(payout, address(bad));
        vm.warp(uint256(_dueDate()) + 1);
        _expectDeferred(inv, address(bad), ETH_PRINCIPAL);
        vm.prank(buyer);
        inv.cancel();
        assertEq(inv.owed(address(bad)), ETH_PRINCIPAL);
    }

    function test_Push_Cancel_Unfunded_NothingSent_NoDeferral() public {
        // an unfunded cancel sends nothing, so nothing can be deferred
        InvoiceEscrow inv = _createEthWithPayout();
        vm.recordLogs();
        vm.prank(seller);
        inv.cancel();
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "Cancelled only");
    }

    function test_Push_Cancel_CallerGasBoundedWithGasBurner() public {
        GasBurner b = new GasBurner();
        InvoiceEscrow inv = _funded(payout, address(b));
        vm.prank(seller);
        uint256 g0 = gasleft();
        inv.cancel();
        assertLt(g0 - gasleft(), 300_000);
        assertEq(inv.owed(address(b)), ETH_PRINCIPAL);
    }

    // ═════════════════════════ settleDirect ═════════════════════════

    function test_Push_SettleDirect_PayoutFails_Credited() public {
        for (uint256 k = 0; k < KINDS; k++) {
            address bad = _bad(k);
            InvoiceEscrow inv = _createEthWith(bad, _defaultTiers());
            _sendEth(buyer, address(inv), 9 ether);
            vm.recordLogs();
            _expectDeferred(inv, bad, 9 ether);
            vm.expectEmit(true, true, false, true, address(inv));
            emit SettledDirect(stranger, REF, bad, 9 ether, 1500);
            vm.prank(stranger);
            inv.settleDirect();
            assertEq(inv.owed(bad), 9 ether, _kindName(k));
            assertEq(address(inv).balance, 9 ether);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
            assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 2, "PayoutDeferred and SettledDirect");
        }
    }

    function test_Push_SettleDirect_CallerGasBoundedWithGasBurner() public {
        GasBurner b = new GasBurner();
        InvoiceEscrow inv = _createEthWith(address(b), _defaultTiers());
        _sendEth(buyer, address(inv), DUE_15);
        vm.prank(stranger);
        uint256 g0 = gasleft();
        inv.settleDirect();
        assertLt(g0 - gasleft(), 300_000);
        assertEq(inv.owed(address(b)), DUE_15);
    }

    function test_Push_SettleDirect_SellerPayoutRejects_DoesNotBlockSettlement() public {
        // the seller itself is the payout and cannot receive ETH
        RejectingReceiver sellerContract = new RejectingReceiver();
        vm.prank(address(sellerContract));
        InvoiceEscrow inv =
            InvoiceEscrow(payable(factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, _dueDate(), _defaultTiers(), address(0))));
        _sendEth(buyer, address(inv), DUE_15);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(inv.owed(address(sellerContract)), DUE_15);
    }

    // ═════════════════════════ the 50_000 gas cap ═════════════════════════

    function test_Push_GasCap_ReceiverNeedingLessThanCapIsPaid() public {
        GasProbe ok = new GasProbe(40_000);
        InvoiceEscrow inv = _funded(address(ok), refund);
        _warpDay(5);
        vm.recordLogs();
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(address(ok).balance, SELLER_15, "pushed, not deferred");
        assertEq(inv.owed(address(ok)), 0);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "Paid only");
    }

    function test_Push_GasCap_ReceiverNeedingMoreThanCapIsDeferred() public {
        GasProbe hungry = new GasProbe(60_000);
        InvoiceEscrow inv = _funded(address(hungry), refund);
        _warpDay(5);
        _expectDeferred(inv, address(hungry), SELLER_15);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(address(hungry).balance, 0);
        assertEq(inv.owed(address(hungry)), SELLER_15);
    }

    function test_Push_GasCap_ReceiverSeesAbout50kGas() public {
        // The pushed call gets PUSH_GAS = 50_000 plus the 2_300 call stipend the EVM adds for a value transfer.
        GasProbe probe = new GasProbe(0);
        InvoiceEscrow inv = _funded(address(probe), refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        uint256 seen = probe.gasSeen();
        assertEq(probe.receiveCalls(), 1);
        assertLe(seen, 50_000 + 2_300, "not more than the cap plus the stipend");
        assertGt(seen, 45_000, "close to the cap, not much less");
    }

    function test_Push_GasCap_AppliesToEveryPath() public {
        // cancel: refund recipient
        GasProbe p1 = new GasProbe(0);
        InvoiceEscrow c = _funded(payout, address(p1));
        vm.prank(seller);
        c.cancel();
        assertEq(p1.receiveCalls(), 1);
        assertLe(p1.gasSeen(), 52_300);
        assertGt(p1.gasSeen(), 45_000);
        // settleDirect: payout recipient
        GasProbe p2 = new GasProbe(0);
        InvoiceEscrow d = _createEthWith(address(p2), _defaultTiers());
        _sendEth(buyer, address(d), DUE_15);
        vm.prank(stranger);
        d.settleDirect();
        assertEq(p2.receiveCalls(), 1);
        assertLe(p2.gasSeen(), 52_300);
        assertGt(p2.gasSeen(), 45_000);
        // trigger: refund recipient
        GasProbe p3 = new GasProbe(0);
        InvoiceEscrow t = _funded(payout, address(p3));
        _warpDay(5);
        vm.prank(seller);
        t.triggerPayment();
        assertEq(p3.receiveCalls(), 1);
        assertLe(p3.gasSeen(), 52_300);
    }

    function test_Push_EmptyCalldataSent() public {
        // the pushed call has empty calldata: a contract with receive() and fallback() reaches receive()
        GasProbe probe = new GasProbe(0);
        InvoiceEscrow inv = _funded(address(probe), refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(probe.receiveCalls(), 1, "receive() was called");
        assertEq(probe.fallbackCalls(), 0, "no calldata, so the fallback was not");
    }

    // ═════════════════════════ reentrancy ═════════════════════════

    uint256 internal constant R_FIRST = 1;
    uint256 internal constant R_LAST = 6;

    function _kind(uint256 i) internal pure returns (ReentrantReceiver.Kind) {
        return ReentrantReceiver.Kind(i);
    }

    function _innerValue(uint256 i) internal pure returns (uint96) {
        if (i == 4) return uint96(ETH_PRINCIPAL); // fund
        if (i == 5) return 1 ether; // plain send
        return 0;
    }

    /// @dev What the re-entered call must revert with, once the status is final and the re-entrant account is a party.
    function _expectedSel(uint256 i, bytes4 cancelSel) internal pure returns (bytes4) {
        if (i == 1) return InvoiceEscrow.NotFunded.selector; // triggerPayment
        if (i == 2) return cancelSel; // cancel
        if (i == 3) return InvoiceEscrow.NotActive.selector; // settleDirect
        if (i == 4) return InvoiceEscrow.NotActive.selector; // fund
        if (i == 5) return InvoiceEscrow.NotActive.selector; // plain ETH to receive()
        return InvoiceEscrow.NothingToWithdraw.selector; // withdraw
    }

    function _assertReentry(ReentrantReceiver r, uint256 i, bytes4 cancelSel) internal view {
        assertTrue(r.fired(), "the callback ran");
        assertFalse(r.ok(), "the re-entered call must revert");
        assertEq(r.sel(), _expectedSel(i, cancelSel), "that function's status error");
    }

    /// @dev Reentrancy during triggerPayment's payout push: the re-entrant account is the seller and payout.
    function test_Reentrancy_Trigger_PayoutRecipientIsSeller() public {
        for (uint256 i = R_FIRST; i <= R_LAST; i++) {
            ReentrantReceiver r = new ReentrantReceiver();
            vm.deal(address(r), 50 ether);
            vm.prank(address(r));
            InvoiceEscrow inv = InvoiceEscrow(
                payable(factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, _dueDate(), _defaultTiers(), address(0)))
            );
            uint256 refundBefore = refund.balance;
            _fundEth(inv, refund);
            r.arm(address(inv), _kind(i), _innerValue(i));
            _warpDay(5);

            vm.prank(buyer);
            inv.triggerPayment();

            _assertReentry(r, i, InvoiceEscrow.AlreadySettled.selector);
            assertEq(address(r).balance, 50 ether + SELLER_15, "paid exactly once");
            assertEq(refund.balance - refundBefore, BUYER_15);
            assertEq(address(inv).balance, 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
            vm.warp(T0);
        }
    }

    /// @dev Reentrancy during triggerPayment's refund push: the re-entrant account is the buyer and refund address.
    function test_Reentrancy_Trigger_RefundRecipientIsBuyer() public {
        for (uint256 i = R_FIRST; i <= R_LAST; i++) {
            ReentrantReceiver r = new ReentrantReceiver();
            vm.deal(address(r), 50 ether);
            InvoiceEscrow inv = _createEthWithPayout();
            uint256 payoutBefore = payout.balance;
            vm.prank(address(r));
            inv.fund{value: ETH_PRINCIPAL}(address(0));
            r.arm(address(inv), _kind(i), _innerValue(i));
            _warpDay(5);

            vm.prank(seller);
            inv.triggerPayment();

            // a buyer cancelling before the due date is not authorised: that check comes first
            _assertReentry(r, i, InvoiceEscrow.NotAuthorizedToCancel.selector);
            assertEq(address(r).balance, 40 ether + BUYER_15, "refunded exactly once");
            assertEq(address(inv).balance, 0);
            assertEq(payout.balance - payoutBefore, SELLER_15);
            vm.warp(T0);
        }
    }

    /// @dev Reentrancy during cancel's refund push: the re-entrant account is the buyer, after the due date.
    function test_Reentrancy_Cancel_RefundRecipientIsBuyerAfterDue() public {
        for (uint256 i = R_FIRST; i <= R_LAST; i++) {
            ReentrantReceiver r = new ReentrantReceiver();
            vm.deal(address(r), 50 ether);
            InvoiceEscrow inv = _createEthWithPayout();
            vm.prank(address(r));
            inv.fund{value: ETH_PRINCIPAL}(address(0));
            r.arm(address(inv), _kind(i), _innerValue(i));
            vm.warp(uint256(_dueDate()) + 1);

            vm.prank(seller);
            inv.cancel();

            _assertReentry(r, i, InvoiceEscrow.AlreadySettled.selector);
            assertEq(address(r).balance, 50 ether, "refunded exactly once");
            assertEq(address(inv).balance, 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
            vm.warp(T0);
        }
    }

    /// @dev Reentrancy during settleDirect's push: the re-entrant account is the seller and payout.
    function test_Reentrancy_SettleDirect_PayoutRecipientIsSeller() public {
        for (uint256 i = R_FIRST; i <= R_LAST; i++) {
            ReentrantReceiver r = new ReentrantReceiver();
            vm.deal(address(r), 50 ether);
            vm.prank(address(r));
            InvoiceEscrow inv = InvoiceEscrow(
                payable(factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, _dueDate(), _defaultTiers(), address(0)))
            );
            _sendEth(buyer, address(inv), DUE_15);
            r.arm(address(inv), _kind(i), _innerValue(i));

            vm.prank(stranger);
            inv.settleDirect();

            _assertReentry(r, i, InvoiceEscrow.AlreadySettled.selector);
            assertEq(address(r).balance, 50 ether + DUE_15, "settled exactly once");
            assertEq(address(inv).balance, 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        }
    }

    /// @dev Reentrancy during withdraw (which forwards all gas): the credit is already zero.
    function test_Reentrancy_Withdraw_ReenteringFindsEverythingFinal() public {
        for (uint256 i = R_FIRST; i <= R_LAST; i++) {
            ReentrantReceiver r = new ReentrantReceiver();
            vm.deal(address(r), 50 ether);
            vm.prank(address(r));
            InvoiceEscrow inv = InvoiceEscrow(
                payable(factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, _dueDate(), _defaultTiers(), address(0)))
            );
            _fundEth(inv, refund);
            r.setRejecting(true);
            _warpDay(5);
            vm.prank(buyer);
            inv.triggerPayment(); // payout push to the seller fails: credited
            assertEq(inv.owed(address(r)), SELLER_15);

            r.setRejecting(false);
            r.arm(address(inv), _kind(i), _innerValue(i));
            vm.expectEmit(true, false, false, true, address(inv));
            emit Withdrawn(address(r), address(r), SELLER_15);
            vm.prank(address(r));
            inv.withdraw(address(r));

            _assertReentry(r, i, InvoiceEscrow.AlreadySettled.selector);
            assertEq(address(r).balance, 50 ether + SELLER_15, "paid exactly once");
            assertEq(inv.owed(address(r)), 0);
            assertEq(address(inv).balance, 0);
            vm.warp(T0);
        }
    }

    // ═════════════════════════ withdraw ═════════════════════════

    /// @dev Paid ETH invoice (day 5, 15%) whose payout contract `bad` rejects ETH: `bad` is owed SELLER_15.
    function _creditedPayout() internal returns (InvoiceEscrow inv, RejectingReceiver bad) {
        bad = new RejectingReceiver();
        inv = _funded(address(bad), refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(bad)), SELLER_15);
    }

    function test_Withdraw_ToSelf() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout();
        bad.setAccepting(true);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(inv));
        emit Withdrawn(address(bad), address(bad), SELLER_15);
        vm.prank(address(bad));
        inv.withdraw(address(bad));
        assertEq(address(bad).balance, SELLER_15);
        assertEq(inv.owed(address(bad)), 0);
        assertEq(address(inv).balance, 0);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "Withdrawn only");
    }

    function test_Withdraw_ToAnotherAddress_ContractThatCannotReceive() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout(); // still rejecting
        address to = makeAddr("eoa");
        vm.expectEmit(true, false, false, true, address(inv));
        emit Withdrawn(address(bad), to, SELLER_15);
        vm.prank(address(bad));
        inv.withdraw(to);
        assertEq(to.balance, SELLER_15);
        assertEq(address(bad).balance, 0);
        assertEq(inv.owed(address(bad)), 0);
    }

    function test_Withdraw_ToZeroAddressIsNotSpecial() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout();
        uint256 before_ = address(0).balance;
        vm.expectEmit(true, false, false, true, address(inv));
        emit Withdrawn(address(bad), address(0), SELLER_15);
        vm.prank(address(bad));
        inv.withdraw(address(0));
        assertEq(address(0).balance - before_, SELLER_15);
        assertEq(inv.owed(address(bad)), 0);
    }

    function test_Withdraw_NothingToWithdraw() public {
        InvoiceEscrow inv = _createEthWithPayout();
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(stranger);
        inv.withdraw(stranger);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(seller);
        inv.withdraw(payout);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(address(0));
        inv.withdraw(stranger);
    }

    function test_Withdraw_SecondWithdrawIsNothingToWithdraw() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout();
        vm.prank(address(bad));
        inv.withdraw(stranger);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(address(bad));
        inv.withdraw(stranger);
    }

    function test_Withdraw_OthersCreditIsNotWithdrawable() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout();
        // the refund recipient and others have no credit; they cannot take the payout's
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(refund);
        inv.withdraw(refund);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(stranger);
        inv.withdraw(stranger);
        assertEq(inv.owed(address(bad)), SELLER_15);
        assertEq(address(inv).balance, SELLER_15);
    }

    function test_Withdraw_FailureKeepsCredit_WithdrawFailed() public {
        (InvoiceEscrow inv, RejectingReceiver bad) = _creditedPayout(); // still rejecting
        vm.expectRevert(InvoiceEscrow.WithdrawFailed.selector);
        vm.prank(address(bad));
        inv.withdraw(address(bad));
        assertEq(inv.owed(address(bad)), SELLER_15, "credit restored");
        assertEq(address(inv).balance, SELLER_15);

        // withdrawing to a recipient that burns all gas fails the same way
        GasBurner burner = new GasBurner();
        vm.expectRevert(InvoiceEscrow.WithdrawFailed.selector);
        vm.prank(address(bad));
        inv.withdraw(address(burner));
        assertEq(inv.owed(address(bad)), SELLER_15);

        // and a later withdraw to a good address works
        vm.prank(address(bad));
        inv.withdraw(stranger);
        assertEq(inv.owed(address(bad)), 0);
    }

    function test_Withdraw_WorksAfterPaid_AndAfterCancelled() public {
        (InvoiceEscrow paid, RejectingReceiver a) = _creditedPayout();
        assertEq(uint8(paid.getInvoice().status), uint8(Status.Paid));
        vm.prank(address(a));
        paid.withdraw(stranger);

        vm.warp(T0);
        RejectingReceiver b = new RejectingReceiver();
        InvoiceEscrow cancelled = _funded(payout, address(b));
        vm.prank(seller);
        cancelled.cancel();
        assertEq(uint8(cancelled.getInvoice().status), uint8(Status.Cancelled));
        assertEq(cancelled.owed(address(b)), ETH_PRINCIPAL);
        uint256 before_ = stranger.balance;
        vm.expectEmit(true, false, false, true, address(cancelled));
        emit Withdrawn(address(b), stranger, ETH_PRINCIPAL);
        vm.prank(address(b));
        cancelled.withdraw(stranger);
        assertEq(stranger.balance - before_, ETH_PRINCIPAL);
    }

    function test_Withdraw_TakesTheWholeAccumulatedCredit() public {
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow inv = _funded(address(bad), address(bad));
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(bad)), ETH_PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Withdrawn(address(bad), stranger, ETH_PRINCIPAL);
        uint256 before_ = stranger.balance;
        vm.prank(address(bad));
        inv.withdraw(stranger);
        assertEq(stranger.balance - before_, ETH_PRINCIPAL);
        assertEq(address(inv).balance, 0);
    }

    function test_Withdraw_CreditsAreSeparatePerInvoice() public {
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow a = _funded(address(bad), refund);
        InvoiceEscrow b = _funded(address(bad), refund);
        vm.prank(seller);
        a.cancel(); // refund to `refund`: no credit for bad
        vm.prank(seller);
        b.triggerPayment();
        assertEq(a.owed(address(bad)), 0);
        assertGt(b.owed(address(bad)), 0);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(address(bad));
        a.withdraw(stranger);
    }

    function test_Withdraw_SendsAllGas_ReceiverNeedingMoreThanPushCapSucceeds() public {
        GasProbe hungry = new GasProbe(60_000);
        InvoiceEscrow inv = _funded(address(hungry), refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(hungry)), SELLER_15, "the push (50k cap) failed");

        vm.expectEmit(true, false, false, true, address(inv));
        emit Withdrawn(address(hungry), address(hungry), SELLER_15);
        vm.prank(address(hungry));
        inv.withdraw(address(hungry));
        assertEq(address(hungry).balance, SELLER_15);
        assertGt(hungry.gasSeen(), 500_000, "withdraw forwards all remaining gas");
        assertEq(inv.owed(address(hungry)), 0);
    }

    function test_Withdraw_ToGasBurnerFailsAfterItStopsBurningSucceeds() public {
        GasBurner burner = new GasBurner();
        InvoiceEscrow inv = _funded(address(burner), refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.WithdrawFailed.selector);
        vm.prank(address(burner));
        inv.withdraw(address(burner));
        assertEq(inv.owed(address(burner)), SELLER_15, "credit kept");
        burner.setBurning(false);
        vm.prank(address(burner));
        inv.withdraw(address(burner));
        assertEq(address(burner).balance, SELLER_15);
    }

    // ═════════════════════════ fuzz ═════════════════════════

    function testFuzz_Push_RejectingRecipients_CreditsConserveValue(uint128 principal, uint16 bps) public {
        principal = uint128(bound(principal, 1, 1_000_000 ether));
        bps = uint16(bound(bps, 0, 10_000));
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 10 days, bps);
        RejectingReceiver p = new RejectingReceiver();
        RejectingReceiver r = new RejectingReceiver();
        InvoiceEscrow inv = _create(seller, REF, NATIVE, principal, _dueDate(), t, address(p));
        vm.deal(buyer, principal);
        vm.prank(buyer);
        inv.fund{value: principal}(address(r));

        uint256 refundAmt = uint256(principal) * bps / 10_000;
        uint256 toSeller = principal - refundAmt;
        vm.prank(buyer);
        inv.triggerPayment(); // must not revert

        assertEq(inv.owed(address(p)), toSeller);
        assertEq(inv.owed(address(r)), refundAmt);
        assertEq(address(inv).balance, principal);

        p.setAccepting(true);
        r.setAccepting(true);
        if (toSeller > 0) {
            vm.prank(address(p));
            inv.withdraw(address(p));
        }
        if (refundAmt > 0) {
            vm.prank(address(r));
            inv.withdraw(address(r));
        }
        assertEq(address(p).balance, toSeller);
        assertEq(address(r).balance, refundAmt);
        assertEq(address(inv).balance, 0);
    }
}
