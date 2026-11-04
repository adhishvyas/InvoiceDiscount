// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {RejectingReceiver} from "../mocks/RejectingReceiver.sol";
import {StipendSender, ForceSend} from "../mocks/Misc.sol";

/// @notice Black-box tests for native-ETH invoices (`token == address(0)`): creation, `fund`, `triggerPayment`,
///         `cancel`, `receive`, `settleDirect`, and the implementation contract (ETH spec 3.1-3.8a, section 6).
///         Push failures, gas, reentrancy and `withdraw` are in `InvoiceEscrowNativeFailures.t.sol`.
contract InvoiceEscrowNativeTest is Base {
    uint256 internal constant SELLER_15 = 8.5 ether; // ETH_PRINCIPAL less 15%
    uint256 internal constant BUYER_15 = 1.5 ether;
    uint256 internal constant DUE_15 = 8.5 ether; // due by direct payment while the 15% tier applies
    uint256 internal constant DUE_10 = 9 ether;

    // ═════════════════════════ creation ═════════════════════════

    function test_Eth_Create_AcceptsAddressZero_EventAndState() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit InvoiceCreated(predicted, seller, REF, address(0), ETH_PRINCIPAL, _dueDate());
        InvoiceEscrow inv = _createEthWithPayout();
        assertEq(address(inv), predicted);

        InvoiceState memory s = inv.getInvoice();
        assertEq(s.token, address(0));
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, payout);
        assertEq(s.principal, ETH_PRINCIPAL);
        assertEq(s.buyer, address(0));
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(s.tiers.length, 2);
        assertEq(address(inv).balance, 0);
        assertEq(inv.owed(seller), 0);
    }

    function test_Eth_Create_DefaultPayoutIsSeller() public {
        InvoiceEscrow inv = _createEth();
        assertEq(inv.getInvoice().payoutAddress, seller);
    }

    function test_Eth_Create_OtherValidationsStillApply() public {
        DiscountTier[] memory ok = _defaultTiers();
        uint64 due = _dueDate();
        vm.startPrank(seller);
        vm.expectRevert(InvoiceEscrow.EmptyInvoiceRef.selector);
        factory.createInvoice(bytes32(0), NATIVE, ETH_PRINCIPAL, due, ok, address(0));
        vm.expectRevert(InvoiceEscrow.InvalidPrincipal.selector);
        factory.createInvoice(REF, NATIVE, 0, due, ok, address(0));
        vm.expectRevert(InvoiceEscrow.DueDateNotInFuture.selector);
        factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, uint64(block.timestamp), ok, address(0));
        vm.expectRevert(InvoiceEscrow.TooManyTiers.selector);
        factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, due, _tiers(11), address(0));
        DiscountTier[] memory bad = new DiscountTier[](1);
        bad[0] = DiscountTier(T0 + 1 days, 10_001);
        vm.expectRevert(InvoiceEscrow.DiscountTooLarge.selector);
        factory.createInvoice(REF, NATIVE, ETH_PRINCIPAL, due, bad, address(0));
        vm.stopPrank();
    }

    function test_Eth_Create_NoCodeAddressesStillInvalidToken() public {
        DiscountTier[] memory ok = _defaultTiers();
        address[4] memory bad = [NO_CODE, seller, address(0x01), address(1)];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(InvoiceEscrow.InvalidToken.selector);
            vm.prank(seller);
            factory.createInvoice(REF, bad[i], ETH_PRINCIPAL, _dueDate(), ok, address(0));
        }
    }

    function test_Eth_Create_InitializeDirectlyAcceptsAddressZero() public {
        InvoiceEscrow c = InvoiceEscrow(payable(Clones.clone(factory.implementation())));
        vm.prank(address(factory));
        c.initialize(seller, REF, address(0), ETH_PRINCIPAL, _dueDate(), _defaultTiers(), address(0));
        assertEq(c.getInvoice().token, address(0));
        assertEq(uint8(c.getInvoice().status), uint8(Status.Active));
    }

    function test_Eth_Create_MakesNoEthMoveAndEmitsNothingFromClone() public {
        vm.recordLogs();
        InvoiceEscrow inv = _createEth();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countFrom(logs, address(inv)), 0);
        assertEq(_countFrom(logs, address(factory)), 1);
        assertEq(address(inv).balance, 0);
    }

    // ═════════════════════════ fund ═════════════════════════

    function test_Eth_Fund_HappyPath() public {
        InvoiceEscrow inv = _createEthWithPayout();
        uint256 buyerBefore = buyer.balance;

        vm.expectEmit(true, true, false, true, address(inv));
        emit Funded(buyer, REF, refund, ETH_PRINCIPAL);
        vm.prank(buyer);
        inv.fund{value: ETH_PRINCIPAL}(refund);

        assertEq(address(inv).balance, ETH_PRINCIPAL);
        assertEq(buyerBefore - buyer.balance, ETH_PRINCIPAL);
        InvoiceState memory s = inv.getInvoice();
        assertEq(uint8(s.status), uint8(Status.Funded));
        assertEq(s.buyer, buyer);
        assertEq(s.refundAddress, refund);
        assertEq(s.principal, ETH_PRINCIPAL);
    }

    function test_Eth_Fund_DefaultRefundAddressIsBuyer() public {
        InvoiceEscrow inv = _createEth();
        vm.expectEmit(true, true, false, true, address(inv));
        emit Funded(buyer, REF, buyer, ETH_PRINCIPAL);
        _fundEth(inv, address(0));
        assertEq(inv.getInvoice().refundAddress, buyer);
        // naming the buyer's own address explicitly is the same
        InvoiceEscrow inv2 = _createEth();
        _fundEth(inv2, buyer);
        assertEq(inv2.getInvoice().refundAddress, buyer);
    }

    function test_Eth_Fund_EmitsOnlyFundedFromEscrow() public {
        InvoiceEscrow inv = _createEth();
        vm.recordLogs();
        _fundEth(inv, refund);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "only Funded; the value arrives with the call");
    }

    function test_Eth_Fund_IncorrectValue_Zero() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, 0, ETH_PRINCIPAL));
        vm.prank(buyer);
        inv.fund(refund);
        _assertStillActive(inv);
    }

    function test_Eth_Fund_IncorrectValue_PrincipalMinusOne() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, uint256(ETH_PRINCIPAL) - 1, ETH_PRINCIPAL)
        );
        vm.prank(buyer);
        inv.fund{value: uint256(ETH_PRINCIPAL) - 1}(refund);
        _assertStillActive(inv);
    }

    function test_Eth_Fund_IncorrectValue_PrincipalPlusOne() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, uint256(ETH_PRINCIPAL) + 1, ETH_PRINCIPAL)
        );
        vm.prank(buyer);
        inv.fund{value: uint256(ETH_PRINCIPAL) + 1}(refund);
        _assertStillActive(inv);
    }

    function test_Eth_Fund_IncorrectValue_Double() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, uint256(ETH_PRINCIPAL) * 2, ETH_PRINCIPAL)
        );
        vm.prank(buyer);
        inv.fund{value: uint256(ETH_PRINCIPAL) * 2}(refund);
        _assertStillActive(inv);
    }

    function test_Fund_Erc20_AnyValueIsIncorrectValueExpectedZero() public {
        InvoiceEscrow inv = _createDefault();
        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        uint256[4] memory vals = [uint256(1), 1 ether, uint256(PRINCIPAL), type(uint96).max];
        for (uint256 i = 0; i < vals.length; i++) {
            vm.deal(buyer, vals[i]);
            vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, vals[i], 0));
            inv.fund{value: vals[i]}(refund);
        }
        vm.stopPrank();
        _assertStillActive(inv);
        assertEq(address(inv).balance, 0);
        assertEq(_bal(address(inv)), 0);
    }

    function test_Fund_Erc20_ZeroValueStillWorks() public {
        InvoiceEscrow inv = _createDefault();
        _fund(inv, refund);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));
        assertEq(_bal(address(inv)), PRINCIPAL);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Fund_CheckOrder_NotActiveFirst() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, address(0));
        // funded: wrong value, from buyer, stranger or seller, all NotActive
        address[3] memory who = [buyer, stranger, seller];
        for (uint256 i = 0; i < who.length; i++) {
            vm.expectRevert(InvoiceEscrow.NotActive.selector);
            vm.prank(who[i]);
            inv.fund{value: 1}(address(0));
            vm.expectRevert(InvoiceEscrow.NotActive.selector);
            vm.prank(who[i]);
            inv.fund{value: ETH_PRINCIPAL}(address(0));
        }
        // cancelled
        InvoiceEscrow c = _createEth();
        vm.prank(seller);
        c.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(seller);
        c.fund{value: 3}(address(0));
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        c.fund{value: ETH_PRINCIPAL}(address(0));
        // paid
        InvoiceEscrow p = _createEth();
        _fundEth(p, address(0));
        vm.prank(seller);
        p.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        p.fund{value: 0}(address(0));
    }

    function test_Eth_Fund_CheckOrder_SellerCannotFundBeforeIncorrectValue() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(InvoiceEscrow.SellerCannotFund.selector);
        vm.prank(seller);
        inv.fund{value: 1}(address(0)); // wrong value, but the seller check comes first
        vm.expectRevert(InvoiceEscrow.SellerCannotFund.selector);
        vm.prank(seller);
        inv.fund{value: ETH_PRINCIPAL}(address(0)); // right value
        vm.expectRevert(InvoiceEscrow.SellerCannotFund.selector);
        vm.prank(seller);
        inv.fund(address(0)); // no value
        _assertStillActive(inv);

        // ERC-20 invoice, with a value
        InvoiceEscrow e = _createDefault();
        vm.expectRevert(InvoiceEscrow.SellerCannotFund.selector);
        vm.prank(seller);
        e.fund{value: 1}(address(0));
    }

    function test_Fund_Erc20_CheckOrder_NotActiveBeforeIncorrectValue() public {
        InvoiceEscrow e = _createDefault();
        vm.prank(seller);
        e.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        e.fund{value: 1}(address(0));
    }

    function test_Eth_Fund_Twice_NotActive() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, address(0));
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(stranger);
        inv.fund{value: ETH_PRINCIPAL}(address(0));
        assertEq(address(inv).balance, ETH_PRINCIPAL, "the second value stays with the caller");
    }

    function testFuzz_Eth_Fund_ValueMustEqualPrincipal(uint128 principal, uint256 value) public {
        principal = uint128(bound(principal, 1, 1_000_000 ether));
        value = bound(value, 0, 2_000_000 ether);
        InvoiceEscrow inv = _create(seller, REF, NATIVE, principal, _dueDate(), _defaultTiers(), address(0));
        vm.deal(buyer, value);
        if (value != principal) {
            vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.IncorrectValue.selector, value, uint256(principal)));
            vm.prank(buyer);
            inv.fund{value: value}(address(0));
            assertEq(address(inv).balance, 0);
        } else {
            vm.prank(buyer);
            inv.fund{value: value}(address(0));
            assertEq(address(inv).balance, principal);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));
        }
    }

    // ═════════════════════════ triggerPayment ═════════════════════════

    function test_Eth_Trigger_FirstTier15Percent() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        _warpDay(5);

        vm.recordLogs();
        _expectPaid(inv, seller, payout, uint128(SELLER_15), refund, uint128(BUYER_15), 1500);
        vm.prank(seller);
        inv.triggerPayment();

        assertEq(payout.balance, SELLER_15);
        assertEq(refund.balance, BUYER_15);
        assertEq(address(inv).balance, 0);
        assertEq(inv.owed(payout), 0);
        assertEq(inv.owed(refund), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "just Paid: nothing deferred");
    }

    function test_Eth_Trigger_SecondTier10Percent_ByBuyer() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        _warpDay(20);
        _expectPaid(inv, buyer, payout, 9 ether, refund, 1 ether, 1000);
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(payout.balance, 9 ether);
        assertEq(refund.balance, 1 ether);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Trigger_NoDiscount_RefundSkipped() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        _warpDay(40);

        vm.recordLogs();
        // Paid still carries the resolved refund address with a zero amount
        _expectPaid(inv, seller, payout, ETH_PRINCIPAL, refund, 0, 0);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(payout.balance, ETH_PRINCIPAL);
        assertEq(refund.balance, 0);
        assertEq(address(inv).balance, 0);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1);
    }

    function test_Eth_Trigger_NoDiscount_RejectingRefundIsNeverCalled() public {
        // a 0% discount sends no refund, so a refund address that would reject creates no credit and no event
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, address(bad));
        _warpDay(40);
        vm.recordLogs();
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(inv.owed(address(bad)), 0);
        assertEq(payout.balance, ETH_PRINCIPAL);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "only Paid");
    }

    function test_Eth_Trigger_FullDiscount_ZeroToSeller_NoSendNoDeferral() public {
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 10 days, 10_000);
        // the payout address would reject any ETH; with 0 to send it must never be called nor credited
        RejectingReceiver bad = new RejectingReceiver();
        InvoiceEscrow inv = _createEthWith(address(bad), t);
        _fundEth(inv, refund);

        vm.recordLogs();
        _expectPaid(inv, seller, address(bad), 0, refund, ETH_PRINCIPAL, 10_000);
        vm.prank(seller);
        inv.triggerPayment();

        assertEq(address(bad).balance, 0);
        assertEq(inv.owed(address(bad)), 0);
        assertEq(refund.balance, ETH_PRINCIPAL);
        assertEq(address(inv).balance, 0);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "only Paid: no PayoutDeferred for a zero amount");
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_Eth_Trigger_NoTiers_FullPrincipalToSeller() public {
        InvoiceEscrow inv = _createEthWith(address(0), _noTiers());
        _fundEth(inv, refund);
        uint256 before_ = seller.balance;
        _expectPaid(inv, buyer, seller, ETH_PRINCIPAL, refund, 0, 0);
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(seller.balance - before_, ETH_PRINCIPAL, "default payout is the seller");
        assertEq(refund.balance, 0);
    }

    function test_Eth_Trigger_DefaultRefundAddressIsBuyer() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, address(0));
        uint256 buyerBefore = buyer.balance;
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(buyer.balance - buyerBefore, BUYER_15);
        assertEq(payout.balance, SELLER_15);
    }

    function test_Eth_Trigger_CutoffBoundaryFallsIntoNextTier() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        vm.warp(T0 + 15 days); // equal to the first cutoff -> 10%
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(refund.balance, 1 ether);
        assertEq(payout.balance, 9 ether);
    }

    function test_Eth_Trigger_RoundingGoesToSeller() public {
        // principal 7 wei at 15%: refund floor(1.05) = 1, seller 6
        InvoiceEscrow inv = _create(seller, REF, NATIVE, 7, _dueDate(), _defaultTiers(), payout);
        vm.prank(buyer);
        inv.fund{value: 7}(refund);
        _expectPaid(inv, seller, payout, 6, refund, 1, 1500);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(payout.balance, 6);
        assertEq(refund.balance, 1);
        assertEq(address(inv).balance, 0);

        // principal 1 wei: the discount rounds to 0
        InvoiceEscrow one = _create(seller, REF, NATIVE, 1, _dueDate(), _defaultTiers(), makeAddr("p2"));
        vm.prank(buyer);
        one.fund{value: 1}(makeAddr("r2"));
        vm.prank(seller);
        one.triggerPayment();
        assertEq(makeAddr("p2").balance, 1);
        assertEq(makeAddr("r2").balance, 0);
    }

    function test_Eth_Trigger_Authorisation_And_Status() public {
        InvoiceEscrow inv = _createEthWithPayout();
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(stranger);
        inv.triggerPayment();
        // before funding: a party gets NotFunded
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();

        _fundEth(inv, refund);
        address[3] memory notParties = [stranger, payout, refund];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(InvoiceEscrow.NotParty.selector);
            vm.prank(notParties[i]);
            inv.triggerPayment();
        }
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(address(0));
        inv.triggerPayment();

        vm.prank(buyer);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Trigger_AfterCancel_NotFunded() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, refund);
        vm.prank(seller);
        inv.cancel();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
    }

    function testFuzz_Eth_Trigger_SplitMatchesFormula(uint128 principal, uint16 bps) public {
        principal = uint128(bound(principal, 1, 1_000_000 ether));
        bps = uint16(bound(bps, 0, 10_000));
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 10 days, bps);
        address p = makeAddr("fuzzPayout");
        address r = makeAddr("fuzzRefund");
        InvoiceEscrow inv = _create(seller, REF, NATIVE, principal, _dueDate(), t, p);
        vm.deal(buyer, principal);
        vm.prank(buyer);
        inv.fund{value: principal}(r);

        uint256 refundAmt = uint256(principal) * bps / 10_000;
        uint256 toSeller = principal - refundAmt;
        _expectPaid(inv, buyer, p, uint128(toSeller), r, uint128(refundAmt), bps);
        vm.prank(buyer);
        inv.triggerPayment();

        assertEq(p.balance, toSeller);
        assertEq(r.balance, refundAmt);
        assertEq(address(inv).balance, 0);
        assertEq(p.balance + r.balance, principal);
    }

    // ═════════════════════════ cancel ═════════════════════════

    function test_Eth_Cancel_Funded_RefundsPrincipalToRefundAddress() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(inv));
        emit Cancelled(seller, REF, ETH_PRINCIPAL);
        vm.prank(seller);
        inv.cancel();
        assertEq(refund.balance, ETH_PRINCIPAL);
        assertEq(address(inv).balance, 0);
        assertEq(payout.balance, 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1);
    }

    function test_Eth_Cancel_Funded_DefaultRefundIsBuyer() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, address(0));
        uint256 before_ = buyer.balance;
        vm.prank(seller);
        inv.cancel();
        assertEq(buyer.balance - before_, ETH_PRINCIPAL);
    }

    function test_Eth_Cancel_Unfunded_NoEthMoves() public {
        InvoiceEscrow inv = _createEthWithPayout();
        uint256 sellerBefore = seller.balance;
        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(inv));
        emit Cancelled(seller, REF, 0);
        vm.prank(seller);
        inv.cancel();
        assertEq(seller.balance, sellerBefore);
        assertEq(address(inv).balance, 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "no PayoutDeferred");
    }

    function test_Eth_Cancel_Unfunded_StrayEthStaysInClone() public {
        // An Active invoice moves no funds on cancel (NatSpec), even if ETH was sent to it.
        InvoiceEscrow inv = _createEth();
        _sendEth(stranger, address(inv), 1 ether);
        vm.prank(seller);
        inv.cancel();
        assertEq(address(inv).balance, 1 ether);
    }

    function test_Eth_Cancel_ByBuyerOnlyAfterDueDate() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _fundEth(inv, refund);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();
        vm.warp(_dueDate());
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();
        vm.warp(uint256(_dueDate()) + 1);
        vm.expectEmit(true, true, false, true, address(inv));
        emit Cancelled(buyer, REF, ETH_PRINCIPAL);
        vm.prank(buyer);
        inv.cancel();
        assertEq(refund.balance, ETH_PRINCIPAL);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Cancel_SellerAfterDueDateStillWorks() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, refund);
        vm.warp(uint256(_dueDate()) + 30 days);
        vm.prank(seller);
        inv.cancel();
        assertEq(refund.balance, ETH_PRINCIPAL);
    }

    function test_Eth_Cancel_AuthorisationAndStatusErrors() public {
        InvoiceEscrow inv = _createEthWithPayout();
        address[4] memory outsiders = [stranger, payout, refund, address(0)];
        _fundEth(inv, refund);
        vm.warp(uint256(_dueDate()) + 1);
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
            vm.prank(outsiders[i]);
            inv.cancel();
        }
        vm.prank(seller);
        inv.cancel();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        inv.cancel();

        vm.warp(T0);
        InvoiceEscrow p = _createEth();
        _fundEth(p, address(0));
        vm.prank(seller);
        p.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        p.cancel();
    }

    // ═════════════════════════ receive() ═════════════════════════

    function test_Eth_Receive_AcceptedWhileActive_EmitsReceived() public {
        InvoiceEscrow inv = _createEth();
        vm.expectEmit(true, true, false, true, address(inv));
        emit Received(stranger, REF, 2 ether);
        (bool ok,) = _sendEth(stranger, address(inv), 2 ether);
        assertTrue(ok);
        assertEq(address(inv).balance, 2 ether);

        // a second payment from someone else, and from the seller
        vm.expectEmit(true, true, false, true, address(inv));
        emit Received(buyer, REF, 1);
        (ok,) = _sendEth(buyer, address(inv), 1);
        assertTrue(ok);
        vm.expectEmit(true, true, false, true, address(inv));
        emit Received(seller, REF, 3);
        (ok,) = _sendEth(seller, address(inv), 3);
        assertTrue(ok);
        assertEq(address(inv).balance, 2 ether + 4);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active), "no state change");
    }

    function test_Eth_Receive_EmitsExactlyOneLog_FromEscrow() public {
        InvoiceEscrow inv = _createEth();
        vm.recordLogs();
        _sendEth(stranger, address(inv), 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(inv));
        assertEq(logs[0].topics[0], Received.selector);
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[2], REF);
        assertEq(abi.decode(logs[0].data, (uint256)), 1 ether);
    }

    function test_Eth_Receive_ZeroValuePlainCallAccepted() public {
        InvoiceEscrow inv = _createEth();
        vm.expectEmit(true, true, false, true, address(inv));
        emit Received(stranger, REF, 0);
        (bool ok,) = _sendEth(stranger, address(inv), 0);
        assertTrue(ok, "a zero-value call with empty calldata reaches receive()");
        assertEq(address(inv).balance, 0);
    }

    function test_Receive_Erc20Invoice_NativeNotAccepted() public {
        InvoiceEscrow inv = _createDefault();
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1 ether);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NativeNotAccepted.selector);
        assertEq(ret.length, 4);
        (ok, ret) = _sendEth(stranger, address(inv), 0);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NativeNotAccepted.selector);
        assertEq(address(inv).balance, 0);
        assertEq(stranger.balance, 1_000 ether);
    }

    function test_Receive_Erc20Invoice_NativeNotAcceptedInEveryStatus() public {
        InvoiceEscrow inv = _createDefault();
        _fund(inv, address(0));
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NativeNotAccepted.selector, "ERC-20 check comes before the status check");
        vm.prank(seller);
        inv.triggerPayment();
        (ok, ret) = _sendEth(stranger, address(inv), 1);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NativeNotAccepted.selector);
    }

    function test_Eth_Receive_NotActiveWhenFunded() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, address(0));
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1 ether);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        (ok, ret) = _sendEth(stranger, address(inv), 0);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        assertEq(address(inv).balance, ETH_PRINCIPAL);
    }

    function test_Eth_Receive_NotActiveWhenPaid() public {
        InvoiceEscrow inv = _createEth();
        _fundEth(inv, address(0));
        vm.prank(seller);
        inv.triggerPayment();
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1 ether);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Receive_NotActiveWhenPaidDirect() public {
        InvoiceEscrow inv = _createEth();
        _sendEth(stranger, address(inv), DUE_15);
        vm.prank(stranger);
        inv.settleDirect();
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1 ether);
        assertFalse(ok, "a late second payment is refused and stays with the payer");
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_Receive_NotActiveWhenCancelled() public {
        InvoiceEscrow inv = _createEth();
        vm.prank(seller);
        inv.cancel();
        uint256 before_ = stranger.balance;
        (bool ok, bytes memory ret) = _sendEth(stranger, address(inv), 1 ether);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        assertEq(stranger.balance, before_);
    }

    function test_Eth_Receive_TransferAndSendWithStipendFail() public {
        InvoiceEscrow inv = _createEth();
        StipendSender s = new StipendSender();
        vm.deal(address(s), 10 ether);
        // `send` returns false; `transfer` reverts. receive() reads storage and emits, which needs more than 2,300 gas.
        assertFalse(s.viaSend(payable(address(inv))));
        vm.expectRevert();
        s.viaTransfer(payable(address(inv)));
        assertEq(address(inv).balance, 0);
        // with ample gas the same contract can pay
        vm.prank(address(s));
        (bool ok,) = address(inv).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(inv).balance, 1 ether);
    }

    function test_Eth_Receive_UnknownCalldataReverts_NoFallback() public {
        InvoiceEscrow inv = _createEth();
        bytes[4] memory datas = [bytes(hex"deadbeef"), hex"00", hex"12345678aabbccdd", abi.encodePacked(bytes4(0xffffffff))];
        for (uint256 i = 0; i < datas.length; i++) {
            vm.prank(stranger);
            (bool ok,) = address(inv).call{value: 0}(datas[i]);
            assertFalse(ok, "no function matches and there is no fallback");
            vm.prank(stranger);
            (ok,) = address(inv).call{value: 1 ether}(datas[i]);
            assertFalse(ok, "with value too");
        }
        assertEq(address(inv).balance, 0);
    }

    function test_Receive_Erc20Invoice_UnknownCalldataReverts() public {
        InvoiceEscrow inv = _createDefault();
        vm.prank(stranger);
        (bool ok,) = address(inv).call{value: 1}(hex"deadbeef");
        assertFalse(ok);
    }

    // ═════════════════════════ settleDirect (ETH) ═════════════════════════

    function test_Eth_SettleDirect_ExactAmount() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(buyer, address(inv), DUE_15);
        uint256 sellerBefore = seller.balance;

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(stranger, REF, payout, DUE_15, 1500);
        vm.prank(stranger);
        inv.settleDirect();

        assertEq(payout.balance, DUE_15);
        assertEq(seller.balance, sellerBefore);
        assertEq(address(inv).balance, 0);
        InvoiceState memory s = inv.getInvoice();
        assertEq(uint8(s.status), uint8(Status.Paid));
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "SettledDirect only (no Paid)");
    }

    function test_Eth_SettleDirect_DefaultPayoutIsSeller() public {
        InvoiceEscrow inv = _createEth();
        _sendEth(buyer, address(inv), DUE_15);
        uint256 before_ = seller.balance;
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(buyer, REF, seller, DUE_15, 1500);
        vm.prank(buyer);
        inv.settleDirect();
        assertEq(seller.balance - before_, DUE_15);
    }

    function test_Eth_SettleDirect_OverpaymentGoesToPayout() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(buyer, address(inv), 9.5 ether);
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(stranger, REF, payout, 9.5 ether, 1500);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(payout.balance, 9.5 ether);
        assertEq(address(inv).balance, 0);
    }

    function test_Eth_SettleDirect_UnderpaymentByNonSellerReverts() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(buyer, address(inv), DUE_15 - 1);
        address[3] memory callers = [stranger, buyer, payout];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, DUE_15 - 1, DUE_15));
            vm.prank(callers[i]);
            inv.settleDirect();
        }
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));
        assertEq(address(inv).balance, DUE_15 - 1);

        // topping up by one wei makes it settle
        _sendEth(buyer, address(inv), 1);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(payout.balance, DUE_15);
    }

    function test_Eth_SettleDirect_SellerMaySettleForLess() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(buyer, address(inv), 1 ether);
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(seller, REF, payout, 1 ether, 1500);
        vm.prank(seller);
        inv.settleDirect();
        assertEq(payout.balance, 1 ether);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_Eth_SettleDirect_NothingToSettle() public {
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(stranger);
        inv.settleDirect();
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(seller);
        inv.settleDirect();
        // a zero-value Received does not create a balance
        _sendEth(stranger, address(inv), 0);
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(seller);
        inv.settleDirect();
    }

    function test_Eth_SettleDirect_CheckOrder_NotActiveBeforeNothingToSettle() public {
        InvoiceEscrow f = _createEth();
        _fundEth(f, address(0)); // Funded, balance = principal
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(stranger);
        f.settleDirect();

        InvoiceEscrow c = _createEth(); // Cancelled, balance 0
        vm.prank(seller);
        c.cancel();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(seller);
        c.settleDirect();

        InvoiceEscrow p = _createEth();
        _sendEth(buyer, address(p), DUE_15);
        vm.prank(stranger);
        p.settleDirect();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(stranger);
        p.settleDirect();
    }

    function test_Eth_SettleDirect_CheckOrder_NothingToSettleBeforeInsufficient() public {
        // balance 0 reports NothingToSettle (not InsufficientDirectPayment(0, due)) for a non-seller
        InvoiceEscrow inv = _createEth();
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(stranger);
        inv.settleDirect();
    }

    function test_Eth_SettleDirect_ForcedEthCounts() public {
        InvoiceEscrow inv = _createEthWithPayout();
        vm.deal(address(inv), DUE_15); // no receive() call, no Received event
        vm.recordLogs();
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(payout.balance, DUE_15);
        assertEq(_countFrom(vm.getRecordedLogs(), address(inv)), 1, "only SettledDirect");
    }

    function test_Eth_SettleDirect_SelfdestructForcedEthCounts() public {
        InvoiceEscrow inv = _createEthWithPayout();
        new ForceSend{value: 9 ether}(payable(address(inv)));
        assertEq(address(inv).balance, 9 ether);
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(stranger, REF, payout, 9 ether, 1500);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(payout.balance, 9 ether);
    }

    function test_Eth_SettleDirect_ForcedEthPlusReceivedAdd() public {
        InvoiceEscrow inv = _createEthWithPayout();
        vm.deal(address(inv), 5 ether);
        _sendEth(buyer, address(inv), 4 ether);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(payout.balance, 9 ether);
    }

    function test_Eth_SettleDirect_DueDependsOnTier() public {
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(buyer, address(inv), DUE_15);
        _warpDay(20); // 10% tier: due 9 ether
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, DUE_15, DUE_10));
        vm.prank(stranger);
        inv.settleDirect();
        _warpDay(40); // no discount: due 10 ether
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, DUE_15, uint256(ETH_PRINCIPAL))
        );
        vm.prank(stranger);
        inv.settleDirect();
        _sendEth(buyer, address(inv), 1.5 ether);
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(stranger, REF, payout, ETH_PRINCIPAL, 0);
        vm.prank(stranger);
        inv.settleDirect();
    }

    function test_Eth_SettleDirect_AfterFundOrTrigger_NotActive_AndFundAfterSettleNotActive() public {
        InvoiceEscrow inv = _createEth();
        _sendEth(buyer, address(inv), DUE_15);
        vm.prank(stranger);
        inv.settleDirect();
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        inv.fund{value: ETH_PRINCIPAL}(address(0));
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        inv.cancel();
    }

    function test_Eth_StrayEthBeforeFunding_StaysAfterTrigger() public {
        // ETH received while Active and then overtaken by fund() stays in the clone (spec 3.11); the split uses
        // the principal only. SPEC_QUESTIONS (ETH) 3.
        InvoiceEscrow inv = _createEthWithPayout();
        _sendEth(stranger, address(inv), 2 ether);
        _fundEth(inv, refund);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(payout.balance, SELLER_15);
        assertEq(refund.balance, BUYER_15);
        assertEq(address(inv).balance, 2 ether);
    }

    function testFuzz_Eth_SettleDirect_ThresholdForNonSeller(uint128 principal, uint16 bps, uint256 paid) public {
        principal = uint128(bound(principal, 1, 1_000_000 ether));
        bps = uint16(bound(bps, 0, 10_000));
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 10 days, bps);
        address p = makeAddr("fuzzPayout");
        InvoiceEscrow inv = _create(seller, REF, NATIVE, principal, _dueDate(), t, p);
        uint256 due = principal - uint256(principal) * bps / 10_000;
        paid = bound(paid, 1, uint256(principal) * 2);
        vm.deal(address(inv), paid);

        if (paid < due) {
            vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, paid, due));
            vm.prank(stranger);
            inv.settleDirect();
            // the seller can still settle for less
            vm.prank(seller);
            inv.settleDirect();
        } else {
            vm.prank(stranger);
            inv.settleDirect();
        }
        assertEq(p.balance, paid);
        assertEq(address(inv).balance, 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    // ═════════════════════════ ERC-20 invoices are unaffected ═════════════════════════

    function test_Erc20_ForcedEthIsIgnoredBySettleDirect() public {
        InvoiceEscrow inv = _createDefault();
        vm.deal(address(inv), 100 ether);
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(stranger);
        inv.settleDirect();
    }

    function test_Eth_TokensSentToEthInvoiceAreIgnoredBySettleDirect() public {
        InvoiceEscrow inv = _createEth();
        vm.prank(buyer);
        token.transfer(address(inv), 1_000e6);
        vm.expectRevert(InvoiceEscrow.NothingToSettle.selector);
        vm.prank(stranger);
        inv.settleDirect();
    }

    function test_Erc20_OwedIsZeroAndWithdrawReverts() public {
        InvoiceEscrow inv = _createDefault();
        assertEq(inv.owed(seller), 0);
        assertEq(inv.owed(address(0)), 0);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(seller);
        inv.withdraw(seller);
        _fund(inv, address(0));
        vm.prank(seller);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(seller);
        inv.withdraw(seller);
        assertEq(inv.owed(seller), 0);
    }

    // ═════════════════════════ the implementation contract (ETH spec 3.8a) ═════════════════════════

    function test_Impl_StatusIsCancelled() public view {
        InvoiceEscrow impl = InvoiceEscrow(payable(factory.implementation()));
        assertEq(uint8(impl.getInvoice().status), uint8(Status.Cancelled));
    }

    function test_Impl_FundRevertsNotActive() public {
        InvoiceEscrow impl = InvoiceEscrow(payable(factory.implementation()));
        // looks like an ETH invoice with principal 0: without the guard, fund() with no value would succeed
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        impl.fund(address(0));
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        impl.fund{value: 1}(address(0));
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(address(0));
        impl.fund(address(0));
    }

    function test_Impl_ReceiveRevertsNotActive() public {
        address impl = factory.implementation();
        (bool ok, bytes memory ret) = _sendEth(stranger, impl, 1 ether);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        (ok, ret) = _sendEth(stranger, impl, 0);
        assertFalse(ok);
        assertEq(_sel(ret), InvoiceEscrow.NotActive.selector);
        assertEq(impl.balance, 0);
    }

    function test_Impl_SettleDirectRevertsNotActive() public {
        InvoiceEscrow impl = InvoiceEscrow(payable(factory.implementation()));
        vm.deal(address(impl), 1 ether); // forced ETH
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(stranger);
        impl.settleDirect();
    }

    function test_Impl_TriggerPaymentReverts() public {
        // NatSpec: reverts "with its status error". The implementation has no seller or buyer, so a real caller
        // gets NotParty, which is checked before NotFunded. SPEC_QUESTIONS (ETH) 5.
        InvoiceEscrow impl = InvoiceEscrow(payable(factory.implementation()));
        vm.prank(stranger);
        try impl.triggerPayment() {
            fail("must revert");
        } catch (bytes memory ret) {
            bytes4 s = _sel(ret);
            assertTrue(
                s == InvoiceEscrow.NotParty.selector || s == InvoiceEscrow.NotFunded.selector, "NotParty or NotFunded"
            );
        }
    }

    function test_Impl_WithdrawAndOwed() public {
        InvoiceEscrow impl = InvoiceEscrow(payable(factory.implementation()));
        assertEq(impl.owed(stranger), 0);
        vm.expectRevert(InvoiceEscrow.NothingToWithdraw.selector);
        vm.prank(stranger);
        impl.withdraw(stranger);
    }

    function test_Impl_ClonesAreUnaffected() public {
        InvoiceEscrow inv = _createEth();
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));
        (bool ok,) = _sendEth(stranger, address(inv), 1);
        assertTrue(ok);
        _fundEth(inv, address(0)); // funding after the stray wei works
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));
    }

    // ═════════════════════════ helpers ═════════════════════════

    function _assertStillActive(InvoiceEscrow inv) internal view {
        InvoiceState memory s = inv.getInvoice();
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(address(inv).balance, 0);
    }
}
