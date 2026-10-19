// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";

/// @notice The 22 tests of spec section 5, plus the section 3.8 worked example.
contract InvoiceEscrowTest is Base {
    // ───────────────────────── helpers ─────────────────────────

    function _assertDefaultTiers(InvoiceState memory s) internal pure {
        assertEq(s.tiers.length, 2);
        assertEq(s.tiers[0].cutoff, T0 + 15 days);
        assertEq(s.tiers[0].discountBps, 1500);
        assertEq(s.tiers[1].cutoff, T0 + 30 days);
        assertEq(s.tiers[1].discountBps, 1000);
    }

    /// @dev Fresh section 3.8 invoice (custom payout), funded at T0 with the custom refund address,
    ///      payment triggered at `ts`. Returns what each receiving wallet gained.
    function _settleAt(uint256 ts, bool byBuyer) internal returns (uint256 toPayout, uint256 toRefund) {
        vm.warp(T0);
        InvoiceEscrow i = _createWithPayout();
        _fund(i, refund);
        uint256 p0 = _bal(payout);
        uint256 r0 = _bal(refund);
        vm.warp(ts);
        vm.prank(byBuyer ? buyer : seller);
        i.triggerPayment();
        assertEq(_bal(address(i)), 0, "escrow must be empty after pay");
        return (_bal(payout) - p0, _bal(refund) - r0);
    }

    function _expectCreateRevert(
        bytes4 err,
        bytes32 ref,
        address tok,
        uint128 principal,
        uint64 due,
        DiscountTier[] memory tiers
    ) internal {
        vm.expectRevert(err);
        vm.prank(seller);
        factory.createInvoice(ref, tok, principal, due, tiers, address(0));
    }

    // ───────────────────── payment and discount tiers ─────────────────────

    function test_FullPaymentAtDueDate() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.warp(_dueDate() + 1);
        assertEq(inv.activeDiscount(uint64(block.timestamp)), 0);
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(_bal(payout), PRINCIPAL);
        assertEq(_bal(refund), 0);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_EarlyPaymentFirstTier() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout), 85_000e6);
        assertEq(_bal(refund), 15_000e6);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_SecondTierAndBoundaries() public {
        uint256 c0 = T0 + 15 days;
        uint256 c1 = T0 + 30 days;
        uint256 due = _dueDate();
        uint256 toP;
        uint256 toR;

        // one second before the first cutoff: 15%
        (toP, toR) = _settleAt(c0 - 1, false);
        assertEq(toP, 85_000e6, "c0-1 payout");
        assertEq(toR, 15_000e6, "c0-1 refund");
        // exactly at the first cutoff: falls into the second tier (strict <)
        (toP, toR) = _settleAt(c0, false);
        assertEq(toP, 90_000e6, "c0 payout");
        assertEq(toR, 10_000e6, "c0 refund");
        // one second after the first cutoff: 10%
        (toP, toR) = _settleAt(c0 + 1, true);
        assertEq(toP, 90_000e6, "c0+1 payout");
        assertEq(toR, 10_000e6, "c0+1 refund");
        // one second before the second cutoff: still 10%
        (toP, toR) = _settleAt(c1 - 1, false);
        assertEq(toP, 90_000e6, "c1-1 payout");
        assertEq(toR, 10_000e6, "c1-1 refund");
        // exactly at the second cutoff: no discount
        (toP, toR) = _settleAt(c1, false);
        assertEq(toP, 100_000e6, "c1 payout");
        assertEq(toR, 0, "c1 refund");
        // at the due date and after: no discount
        (toP, toR) = _settleAt(due, true);
        assertEq(toP, 100_000e6, "due payout");
        assertEq(toR, 0, "due refund");
        (toP, toR) = _settleAt(due + 365 days, false);
        assertEq(toP, 100_000e6, "late payout");
        assertEq(toR, 0, "late refund");
        // at the invoice's very creation second: first tier
        (toP, toR) = _settleAt(T0, false);
        assertEq(toP, 85_000e6, "T0 payout");
        assertEq(toR, 15_000e6, "T0 refund");
    }

    function test_RoundingFavoursSeller() public {
        // 1_000_001 * 1500 / 10_000 = 150_000.15 -> refund floors to 150_000, seller gets 850_001
        _roundingCase(1_000_001, 150_000, 850_001);
        // 7 * 1500 / 10_000 = 1.05 -> refund 1, seller 6
        _roundingCase(7, 1, 6);
        // 3 * 1500 / 10_000 = 0.45 -> refund 0, seller 3 (and no refund transfer)
        _roundingCase(3, 0, 3);
        // 1 unit
        _roundingCase(1, 0, 1);
        // 6_666 * 1500 / 10_000 = 999.9 -> refund 999, seller 5_667
        _roundingCase(6_666, 999, 5_667);
        // 9_999 * 1500 / 10_000 = 1499.85 -> refund 1499, seller 8_500
        _roundingCase(9_999, 1499, 8_500);
        // 99_999_999_999_999_999 * 1500 / 10_000 = 14_999_999_999_999_999.85
        _roundingCase(99_999_999_999_999_999, 14_999_999_999_999_999, 85_000_000_000_000_000);
    }

    function _roundingCase(uint128 principal, uint256 expRefund, uint256 expSeller) internal {
        vm.warp(T0);
        _mint(token, buyer, principal);
        InvoiceEscrow inv = _create(seller, REF, address(token), principal, _dueDate(), _defaultTiers(), payout);
        _fund(inv, refund);
        uint256 p0 = _bal(payout);
        uint256 r0 = _bal(refund);
        _warpDay(1);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout) - p0, expSeller, "seller share");
        assertEq(_bal(refund) - r0, expRefund, "refund share");
        assertEq(expSeller + expRefund, principal, "split must sum to principal");
        assertEq(_bal(address(inv)), 0, "no dust left in escrow");
    }

    // ───────────────────────── cancel ─────────────────────────

    function test_CancelBeforeFundRefundsNothing() public {
        InvoiceEscrow inv = _createWithPayout();
        Bals memory before_ = _snap(address(inv));
        vm.recordLogs();
        vm.prank(seller);
        inv.cancel();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Bals memory after_ = _snap(address(inv));
        assertEq(after_.seller, before_.seller);
        assertEq(after_.buyer, before_.buyer);
        assertEq(after_.payout, before_.payout);
        assertEq(after_.refund, before_.refund);
        assertEq(after_.escrow, 0);
        assertEq(_countFrom(logs, address(token)), 0, "no token event at all");
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
        assertEq(inv.getInvoice().buyer, address(0));
    }

    function test_SellerCancelsUnfundedAfterDueDate() public {
        InvoiceEscrow inv = _createDefault();
        vm.warp(_dueDate() + 30 days);
        vm.prank(seller);
        inv.cancel();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
    }

    function test_CancelAfterFundRefundsBuyer() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        uint256 buyerBefore = _bal(buyer);
        uint256 sellerBefore = _bal(seller);
        _warpDay(5);
        vm.prank(seller);
        inv.cancel();
        assertEq(_bal(refund), PRINCIPAL, "full principal to refund address");
        assertEq(_bal(buyer), buyerBefore, "buyer wallet itself gets nothing when refund address is custom");
        assertEq(_bal(payout), 0);
        assertEq(_bal(seller), sellerBefore);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
    }

    function test_BuyerCancelOnlyAfterDueDate() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);

        // well before, one second before, and exactly at the due date: not allowed
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();

        vm.warp(_dueDate() - 1);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();

        vm.warp(_dueDate());
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));

        // one second after the due date: allowed
        vm.warp(_dueDate() + 1);
        vm.prank(buyer);
        inv.cancel();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
        assertEq(_bal(refund), PRINCIPAL);
        assertEq(_bal(address(inv)), 0);
    }

    // ───────────────────────── getInvoice ─────────────────────────

    function test_GetInvoiceReturnsState() public {
        InvoiceEscrow inv = _createWithPayout();
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.invoiceRef, REF);
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, payout);
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(s.token, address(token));
        assertEq(s.principal, PRINCIPAL);
        assertEq(s.dueDate, _dueDate());
        assertEq(uint8(s.status), uint8(Status.Active));
        _assertDefaultTiers(s);

        _fund(inv, refund);
        s = inv.getInvoice();
        assertEq(s.buyer, buyer);
        assertEq(s.refundAddress, refund);
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, payout);
        assertEq(uint8(s.status), uint8(Status.Funded));
        _assertDefaultTiers(s);
    }

    // ───────────────────────── payout / refund addresses ─────────────────────────

    function test_PayoutDefaultsToSeller() public {
        InvoiceEscrow inv = _createDefault();
        assertEq(inv.getInvoice().payoutAddress, seller, "resolved on read");
        _fund(inv, refund);
        assertEq(inv.getInvoice().payoutAddress, seller);
        uint256 sellerBefore = _bal(seller);
        _warpDay(5);
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(_bal(seller) - sellerBefore, 85_000e6);
        assertEq(_bal(refund), 15_000e6);
    }

    function test_CustomPayoutAddress() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        uint256 sellerBefore = _bal(seller);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout), 85_000e6);
        assertEq(_bal(seller), sellerBefore, "seller wallet itself gets nothing");
        assertEq(inv.getInvoice().payoutAddress, payout);
    }

    function test_RefundDefaultsToBuyer() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, address(0));
        assertEq(inv.getInvoice().refundAddress, buyer, "resolved on read");
        uint256 buyerAfterFund = _bal(buyer);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(buyer) - buyerAfterFund, 15_000e6);
        assertEq(_bal(payout), 85_000e6);
        assertEq(_bal(refund), 0);
    }

    function test_CustomRefundAddress() public {
        // discount refund goes to the refund address
        InvoiceEscrow a = _createWithPayout();
        _fund(a, refund);
        uint256 buyerAfterFund = _bal(buyer);
        _warpDay(5);
        vm.prank(buyer);
        a.triggerPayment();
        assertEq(_bal(refund), 15_000e6);
        assertEq(_bal(buyer), buyerAfterFund, "buyer wallet itself gets nothing");

        // cancellation refund goes to the refund address
        vm.warp(T0);
        InvoiceEscrow b = _createWithPayout();
        _fund(b, refund);
        buyerAfterFund = _bal(buyer);
        uint256 refundBefore = _bal(refund);
        vm.prank(seller);
        b.cancel();
        assertEq(_bal(refund) - refundBefore, PRINCIPAL);
        assertEq(_bal(buyer), buyerAfterFund);
    }

    function test_PayoutAndRefundAddressesCannotAct() public {
        InvoiceEscrow inv = _createWithPayout();

        // while Active
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(payout);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(payout);
        inv.cancel();
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(refund);
        inv.cancel();

        _fund(inv, refund);

        // while Funded, before and after the due date
        for (uint256 k = 0; k < 2; k++) {
            if (k == 1) vm.warp(_dueDate() + 1);
            vm.expectRevert(InvoiceEscrow.NotParty.selector);
            vm.prank(payout);
            inv.triggerPayment();
            vm.expectRevert(InvoiceEscrow.NotParty.selector);
            vm.prank(refund);
            inv.triggerPayment();
            vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
            vm.prank(payout);
            inv.cancel();
            vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
            vm.prank(refund);
            inv.cancel();
        }
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));
        assertEq(_bal(address(inv)), PRINCIPAL);
    }

    // ───────────────────────── fund ─────────────────────────

    function test_SellerCannotFund() public {
        InvoiceEscrow inv = _createDefault();
        vm.startPrank(seller);
        token.approve(address(inv), PRINCIPAL);
        vm.expectRevert(InvoiceEscrow.SellerCannotFund.selector);
        inv.fund(address(0));
        vm.stopPrank();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));
        assertEq(inv.getInvoice().buyer, address(0));
        assertEq(_bal(address(inv)), 0);
    }

    function test_FundSetsBuyer_FundTwiceReverts() public {
        InvoiceEscrow inv = _createDefault();
        _fund(inv, address(0));
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.buyer, buyer);
        assertEq(uint8(s.status), uint8(Status.Funded));
        assertEq(_bal(address(inv)), PRINCIPAL);

        // same buyer again
        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        inv.fund(address(0));
        vm.stopPrank();

        // different wallet cannot take over the buyer slot
        vm.startPrank(stranger);
        token.approve(address(inv), PRINCIPAL);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        inv.fund(refund);
        vm.stopPrank();

        s = inv.getInvoice();
        assertEq(s.buyer, buyer, "buyer unchanged");
        assertEq(s.refundAddress, buyer, "refund unchanged");
        assertEq(_bal(address(inv)), PRINCIPAL, "escrow holds exactly one principal");
    }

    // ───────────────────────── trigger payment access ─────────────────────────

    function test_TriggerPaymentOnlyParties() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(stranger);
        inv.triggerPayment();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));

        // both parties may trigger
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));

        vm.warp(T0);
        InvoiceEscrow inv2 = _createWithPayout();
        _fund(inv2, refund);
        vm.prank(buyer);
        inv2.triggerPayment();
        assertEq(uint8(inv2.getInvoice().status), uint8(Status.Paid));
    }

    function test_CannotCancelOrPayAfterSettled() public {
        // Paid
        InvoiceEscrow paid = _createWithPayout();
        _fund(paid, refund);
        vm.prank(seller);
        paid.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        paid.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(buyer);
        paid.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        paid.cancel();
        vm.warp(_dueDate() + 1);
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(buyer);
        paid.cancel();

        // Cancelled (funded)
        vm.warp(T0);
        InvoiceEscrow cx = _createWithPayout();
        _fund(cx, refund);
        vm.prank(seller);
        cx.cancel();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        cx.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(buyer);
        cx.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        cx.cancel();
        vm.warp(_dueDate() + 1);
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(buyer);
        cx.cancel();

        // balances untouched by the failed calls
        assertEq(_bal(address(paid)), 0);
        assertEq(_bal(address(cx)), 0);
        assertEq(_bal(payout), 85_000e6, "payout got exactly one settlement (the Paid invoice, paid at T0 = tier 1)");
        assertEq(_bal(refund), 15_000e6 + PRINCIPAL, "refund: discount of the Paid invoice plus one cancellation");
    }

    // ───────────────────────── factory / init ─────────────────────────

    function test_FactorySetsSellerToCaller() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit InvoiceCreated(predicted, seller, REF, address(token), PRINCIPAL, _dueDate());
        vm.prank(seller);
        address inv = factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        assertEq(inv, predicted, "returned address is the clone that was initialised");
        assertEq(InvoiceEscrow(inv).getInvoice().seller, seller);

        // someone else calling gets their own invoice with themselves as seller
        vm.prank(stranger);
        address inv2 = factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), address(0));
        assertTrue(inv2 != inv);
        assertEq(InvoiceEscrow(inv2).getInvoice().seller, stranger);
        assertEq(InvoiceEscrow(inv2).getInvoice().payoutAddress, stranger);
    }

    function test_InitializeOnlyOnceAndOnlyFactory() public {
        InvoiceEscrow inv = _createDefault();
        InvoiceEscrow impl = InvoiceEscrow(factory.implementation());
        DiscountTier[] memory tiers = _defaultTiers();

        // NotFactory on a clone, from several callers (including the seller, and the clone itself)
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(stranger);
        inv.initialize(stranger, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(seller);
        inv.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(address(inv));
        inv.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));

        // NotFactory on the implementation
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(stranger);
        impl.initialize(stranger, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));

        // NotFactory is checked BEFORE AlreadyInitialized, and before any argument validation
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(stranger);
        inv.initialize(stranger, bytes32(0), address(0), 0, 0, tiers, address(0));

        // the factory itself: AlreadyInitialized on the clone ...
        vm.expectRevert(InvoiceEscrow.AlreadyInitialized.selector);
        vm.prank(address(factory));
        inv.initialize(stranger, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        // ... and on the implementation, even with otherwise-valid arguments
        vm.expectRevert(InvoiceEscrow.AlreadyInitialized.selector);
        vm.prank(address(factory));
        impl.initialize(stranger, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        // AlreadyInitialized is checked before argument validation
        vm.expectRevert(InvoiceEscrow.AlreadyInitialized.selector);
        vm.prank(address(factory));
        impl.initialize(stranger, bytes32(0), address(0), 0, 0, tiers, address(0));

        // the failed re-initialisations changed nothing
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.seller, seller);
        assertEq(s.principal, PRINCIPAL);
    }

    // ───────────────────────── validation errors ─────────────────────────

    function test_ValidationErrors() public {
        uint64 due = _dueDate();
        DiscountTier[] memory ok = _defaultTiers();
        address tok = address(token);

        // EmptyInvoiceRef
        _expectCreateRevert(InvoiceEscrow.EmptyInvoiceRef.selector, bytes32(0), tok, PRINCIPAL, due, ok);
        // InvalidPrincipal
        _expectCreateRevert(InvoiceEscrow.InvalidPrincipal.selector, REF, tok, 0, due, ok);
        // DueDateNotInFuture: in the past, equal to now
        _expectCreateRevert(InvoiceEscrow.DueDateNotInFuture.selector, REF, tok, PRINCIPAL, T0 - 1, _noTiers());
        _expectCreateRevert(InvoiceEscrow.DueDateNotInFuture.selector, REF, tok, PRINCIPAL, T0, _noTiers());
        _expectCreateRevert(InvoiceEscrow.DueDateNotInFuture.selector, REF, tok, PRINCIPAL, 0, _noTiers());
        // TooManyTiers
        _expectCreateRevert(InvoiceEscrow.TooManyTiers.selector, REF, tok, PRINCIPAL, due, _tiers(11));
        // TiersNotAscending: first cutoff zero, equal cutoffs, descending cutoffs
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(0, 100);
        _expectCreateRevert(InvoiceEscrow.TiersNotAscending.selector, REF, tok, PRINCIPAL, due, t);
        t = new DiscountTier[](2);
        t[0] = DiscountTier(T0 + 10, 200);
        t[1] = DiscountTier(T0 + 10, 100);
        _expectCreateRevert(InvoiceEscrow.TiersNotAscending.selector, REF, tok, PRINCIPAL, due, t);
        t[1] = DiscountTier(T0 + 9, 100);
        _expectCreateRevert(InvoiceEscrow.TiersNotAscending.selector, REF, tok, PRINCIPAL, due, t);
        // TierAfterDueDate: one second after
        t = new DiscountTier[](1);
        t[0] = DiscountTier(due + 1, 100);
        _expectCreateRevert(InvoiceEscrow.TierAfterDueDate.selector, REF, tok, PRINCIPAL, due, t);
        // DiscountTooLarge
        t[0] = DiscountTier(T0 + 10, 10_001);
        _expectCreateRevert(InvoiceEscrow.DiscountTooLarge.selector, REF, tok, PRINCIPAL, due, t);
        t[0] = DiscountTier(T0 + 10, type(uint16).max);
        _expectCreateRevert(InvoiceEscrow.DiscountTooLarge.selector, REF, tok, PRINCIPAL, due, t);
        // NotTIP20
        _expectCreateRevert(InvoiceEscrow.NotTIP20.selector, REF, UNPREFIXED, PRINCIPAL, due, ok);
        _expectCreateRevert(InvoiceEscrow.NotTIP20.selector, REF, address(0), PRINCIPAL, due, ok);
        _expectCreateRevert(InvoiceEscrow.NotTIP20.selector, REF, PREFIXED_NO_CODE, PRINCIPAL, due, ok);
        _expectCreateRevert(InvoiceEscrow.NotTIP20.selector, REF, address(factory), PRINCIPAL, due, ok);
        _expectCreateRevert(InvoiceEscrow.NotTIP20.selector, REF, seller, PRINCIPAL, due, ok);
        _expectCreateRevert(
            InvoiceEscrow.NotTIP20.selector, REF, StdPrecompiles.STABLECOIN_DEX_ADDRESS, PRINCIPAL, due, ok
        );
        _expectCreateRevert(
            InvoiceEscrow.NotTIP20.selector, REF, StdPrecompiles.TIP20_FACTORY_ADDRESS, PRINCIPAL, due, ok
        );
    }

    // ───────────────────────── memo ─────────────────────────

    function test_TransfersCarryInvoiceRefMemo() public {
        // fund
        InvoiceEscrow a = _createWithPayout();
        vm.startPrank(buyer);
        token.approve(address(a), PRINCIPAL);
        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(buyer, address(a), PRINCIPAL, REF);
        a.fund(refund);
        vm.stopPrank();

        // pay: payout transfer, then refund transfer
        _warpDay(5);
        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(address(a), payout, 85_000e6, REF);
        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(address(a), refund, 15_000e6, REF);
        vm.prank(seller);
        a.triggerPayment();

        // cancel after funding
        vm.warp(T0);
        InvoiceEscrow b = _create(seller, bytes32("OTHER-REF"), address(token), 5_000e6, _dueDate(), _defaultTiers(), payout);
        _fundAs(b, buyer, refund);
        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(address(b), refund, 5_000e6, bytes32("OTHER-REF"));
        vm.prank(seller);
        b.cancel();
    }

    function test_MemoLogsAreExactlyTheExpectedOnes() public {
        InvoiceEscrow inv = _createWithPayout();

        vm.recordLogs();
        _fund(inv, refund);
        MemoLog[] memory m = _memoLogs(vm.getRecordedLogs());
        assertEq(m.length, 1);
        assertEq(m[0].from, buyer);
        assertEq(m[0].to, address(inv));
        assertEq(m[0].amount, PRINCIPAL);
        assertEq(m[0].memo, REF);

        _warpDay(20);
        vm.recordLogs();
        vm.prank(buyer);
        inv.triggerPayment();
        m = _memoLogs(vm.getRecordedLogs());
        assertEq(m.length, 2, "payout transfer and refund transfer, nothing else");
        assertEq(m[0].from, address(inv));
        assertEq(m[0].to, payout);
        assertEq(m[0].amount, 90_000e6);
        assertEq(m[0].memo, REF);
        assertEq(m[1].from, address(inv));
        assertEq(m[1].to, refund);
        assertEq(m[1].amount, 10_000e6);
        assertEq(m[1].memo, REF);

        // no discount: only the payout transfer
        vm.warp(T0);
        InvoiceEscrow inv2 = _createWithPayout();
        _fund(inv2, refund);
        vm.warp(_dueDate());
        vm.recordLogs();
        vm.prank(buyer);
        inv2.triggerPayment();
        m = _memoLogs(vm.getRecordedLogs());
        assertEq(m.length, 1, "no refund transfer when refund is 0");
        assertEq(m[0].to, payout);
        assertEq(m[0].amount, PRINCIPAL);
        assertEq(m[0].memo, REF);

        // cancel: exactly one transfer, to the refund address
        vm.warp(T0);
        InvoiceEscrow inv3 = _createWithPayout();
        _fund(inv3, refund);
        vm.recordLogs();
        vm.prank(seller);
        inv3.cancel();
        m = _memoLogs(vm.getRecordedLogs());
        assertEq(m.length, 1);
        assertEq(m[0].from, address(inv3));
        assertEq(m[0].to, refund);
        assertEq(m[0].amount, PRINCIPAL);
        assertEq(m[0].memo, REF);
    }

    // ───────────────────────── section 3.8 worked example ─────────────────────────

    function test_WorkedExample() public {
        uint256[3] memory dayOf = [uint256(5), 20, 45];
        uint256[3] memory expPayout = [uint256(85_000e6), 90_000e6, 100_000e6];
        uint256[3] memory expRefund = [uint256(15_000e6), 10_000e6, 0];

        for (uint256 k = 0; k < 3; k++) {
            vm.warp(T0);
            bytes32 ref = bytes32("INV-2026-0042");
            InvoiceEscrow inv = _create(seller, ref, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
            _fund(inv, refund);
            uint256 p0 = _bal(payout);
            uint256 r0 = _bal(refund);
            _warpDay(dayOf[k]);
            vm.expectEmit(true, true, true, true, address(token));
            emit TransferWithMemo(address(inv), payout, expPayout[k], ref);
            vm.prank(k % 2 == 0 ? seller : buyer);
            inv.triggerPayment();
            assertEq(_bal(payout) - p0, expPayout[k], "payout, day");
            assertEq(_bal(refund) - r0, expRefund[k], "refund, day");
            assertEq(_bal(address(inv)), 0);
        }

        // cancelled after funding: 0 to the seller's payout address, 100,000 to the refund address
        vm.warp(T0);
        InvoiceEscrow c = _createWithPayout();
        _fund(c, refund);
        uint256 p1 = _bal(payout);
        uint256 r1 = _bal(refund);
        _warpDay(5);
        vm.prank(seller);
        c.cancel();
        assertEq(_bal(payout) - p1, 0);
        assertEq(_bal(refund) - r1, 100_000e6);
    }
}
