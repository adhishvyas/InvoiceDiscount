// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";

/// @notice Adversarial tests: boundaries, rounding, events, balances, token failures, state machine.
contract InvoiceEscrowEdgeTest is Base {
    function _one(uint64 cutoff, uint16 bps) internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](1);
        t[0] = DiscountTier(cutoff, bps);
    }

    function _st(InvoiceEscrow i) internal view returns (Status) {
        return i.getInvoice().status;
    }

    // ═════════════════════════ tier count and bps limits ═════════════════════════

    function test_TenTiersAccepted_ElevenRejected() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _tiers(10), address(0));
        assertEq(inv.getInvoice().tiers.length, 10);

        vm.expectRevert(InvoiceEscrow.TooManyTiers.selector);
        vm.prank(seller);
        factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _tiers(11), address(0));
    }

    function test_TenTiers_EveryBoundary() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _tiers(10), address(0));
        // _tiers(10): cutoff_i = T0 + (i+1) days, bps_i = 100 * (10 - i)
        for (uint256 i = 0; i < 10; i++) {
            uint64 c = T0 + uint64((i + 1) * DAY);
            assertEq(inv.activeDiscount(c - 1), uint16(100 * (10 - i)), "just before cutoff");
            uint16 next = i == 9 ? 0 : uint16(100 * (10 - i - 1));
            assertEq(inv.activeDiscount(c), next, "exactly at cutoff -> next tier");
        }
        assertEq(inv.activeDiscount(0), 1000);
        assertEq(inv.activeDiscount(type(uint64).max), 0);
    }

    function test_SettleInTenthTier() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _tiers(10), payout);
        _fund(inv, refund);
        vm.warp(T0 + 10 days - 1); // tenth tier: 100 bps = 1%
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(refund), 1_000e6);
        assertEq(_bal(payout), 99_000e6);
    }

    function test_BpsBoundary_10000Accepted_10001Rejected() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _one(T0 + 1 days, 10_000), address(0));
        assertEq(inv.getInvoice().tiers[0].discountBps, 10_000);
        assertEq(inv.activeDiscount(T0), 10_000);

        vm.expectRevert(InvoiceEscrow.DiscountTooLarge.selector);
        vm.prank(seller);
        factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _one(T0 + 1 days, 10_001), address(0));

        // an oversized bps in the LAST tier is also caught
        DiscountTier[] memory t = _tiers(10);
        t[9].discountBps = 10_001;
        vm.expectRevert(InvoiceEscrow.DiscountTooLarge.selector);
        vm.prank(seller);
        factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), t, address(0));
    }

    function test_FullDiscount_SellerGetsZero() public {
        InvoiceEscrow inv =
            _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _one(T0 + 10 days, 10_000), payout);
        _fund(inv, refund);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Paid(seller, payout, 0, refund, PRINCIPAL, 10_000);
        vm.recordLogs();
        vm.prank(seller);
        inv.triggerPayment();
        MemoLog[] memory m = _memoLogs(vm.getRecordedLogs());
        assertEq(_bal(payout), 0);
        assertEq(_bal(refund), PRINCIPAL);
        assertEq(_bal(address(inv)), 0);
        assertEq(uint8(_st(inv)), uint8(Status.Paid));
        // SPEC-QUESTION 2: whether a zero-value payout transfer is made is unspecified; if one is made it must
        // carry amount 0 and the memo; the refund transfer must always be present.
        bool refundSeen;
        for (uint256 i = 0; i < m.length; i++) {
            assertEq(m[i].memo, REF);
            if (m[i].to == payout) assertEq(m[i].amount, 0);
            if (m[i].to == refund) {
                assertEq(m[i].amount, PRINCIPAL);
                refundSeen = true;
            }
        }
        assertTrue(refundSeen);
    }

    function test_ZeroBpsTier_NoRefund() public {
        // SPEC-QUESTION 4: a tier with discountBps == 0 is allowed.
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _one(T0 + 10 days, 0), payout);
        _fund(inv, refund);
        vm.recordLogs();
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(_memoLogs(vm.getRecordedLogs()).length, 1, "only the payout transfer");
        assertEq(_bal(payout), PRINCIPAL);
        assertEq(_bal(refund), 0);
    }

    // ═════════════════════════ uint128 max and rounding ═════════════════════════

    function test_MaxPrincipal_PayWithDiscount() public {
        ITIP20 big = _newToken("BIG", bytes32(uint256(77)));
        _mint(big, buyer, type(uint128).max);
        InvoiceEscrow inv =
            _create(seller, REF, address(big), type(uint128).max, _dueDate(), _defaultTiers(), payout);
        assertEq(inv.getInvoice().principal, type(uint128).max);
        vm.startPrank(buyer);
        big.approve(address(inv), type(uint128).max);
        inv.fund(refund);
        vm.stopPrank();
        assertEq(big.balanceOf(address(inv)), type(uint128).max);

        _warpDay(1);
        vm.prank(seller);
        inv.triggerPayment(); // must not overflow: principal * bps is computed in a wider type
        uint256 expRefund = (uint256(type(uint128).max) * 1500) / 10_000;
        assertEq(big.balanceOf(refund), expRefund);
        assertEq(big.balanceOf(payout), uint256(type(uint128).max) - expRefund);
        assertEq(big.balanceOf(address(inv)), 0);
    }

    function test_MaxPrincipal_FullDiscountAndCancel() public {
        ITIP20 big = _newToken("BIG", bytes32(uint256(78)));
        _mint(big, buyer, type(uint128).max);
        InvoiceEscrow inv =
            _create(seller, REF, address(big), type(uint128).max, _dueDate(), _one(T0 + 1 days, 10_000), payout);
        vm.startPrank(buyer);
        big.approve(address(inv), type(uint128).max);
        inv.fund(refund);
        vm.stopPrank();
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(big.balanceOf(refund), type(uint128).max);
        assertEq(big.balanceOf(payout), 0);

        // cancel with max principal
        ITIP20 big2 = _newToken("BIG2", bytes32(uint256(79)));
        _mint(big2, stranger, type(uint128).max);
        InvoiceEscrow inv2 = _create(seller, REF, address(big2), type(uint128).max, _dueDate(), _noTiers(), payout);
        vm.startPrank(stranger);
        big2.approve(address(inv2), type(uint128).max);
        inv2.fund(address(0));
        vm.stopPrank();
        vm.prank(seller);
        inv2.cancel();
        assertEq(big2.balanceOf(stranger), type(uint128).max);
    }

    function test_MaxPrincipalCreatedWithoutFunds() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), type(uint128).max, _dueDate(), _noTiers(), address(0));
        assertEq(inv.getInvoice().principal, type(uint128).max);
    }

    function testFuzz_PaymentSplit(uint128 principal, uint16 bpsSeed, uint32 offsetSeed) public {
        principal = uint128(bound(principal, 1, uint256(type(uint128).max) / 2));
        uint16 bps = uint16(bound(bpsSeed, 0, 10_000));
        uint256 ts = T0 + bound(offsetSeed, 0, 70 days);
        uint64 cutoff = T0 + 10 days;

        _mint(token, buyer, principal);
        InvoiceEscrow inv = _create(seller, REF, address(token), principal, _dueDate(), _one(cutoff, bps), payout);
        _fund(inv, refund);
        vm.warp(ts);
        vm.prank(buyer);
        inv.triggerPayment();

        uint256 appliedBps = ts < cutoff ? bps : 0;
        uint256 expRefund = (uint256(principal) * appliedBps) / 10_000;
        assertEq(_bal(refund), expRefund);
        assertEq(_bal(payout), uint256(principal) - expRefund);
        assertEq(_bal(address(inv)), 0);
    }

    function testFuzz_ActiveDiscountMatchesModel(uint256 seed, uint8 nSeed, uint64 query) public {
        uint256 n = bound(nSeed, 0, 10);
        DiscountTier[] memory t = new DiscountTier[](n);
        uint64 c = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            c += uint64(1 + (h % 5 days));
            t[i] = DiscountTier(c, uint16((h >> 64) % 10_001));
        }
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), t, address(0));
        // query near the tiers as well as anywhere
        uint64 q = (query % 3 == 0) ? query : uint64(uint256(query) % (c + 2 days));
        uint16 exp = 0;
        for (uint256 i = 0; i < n; i++) {
            if (q < t[i].cutoff) {
                exp = t[i].discountBps;
                break;
            }
        }
        assertEq(inv.activeDiscount(q), exp);
    }

    // ═════════════════════════ tiers and due date ═════════════════════════

    function test_TierCutoffEqualsDueDate() public {
        uint64 due = _dueDate();
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, due, _one(due, 500), payout);
        assertEq(inv.getInvoice().tiers[0].cutoff, due);
        assertEq(inv.activeDiscount(due - 1), 500);
        assertEq(inv.activeDiscount(due), 0);
        _fund(inv, refund);

        // at due - 1 the discount applies
        vm.warp(due - 1);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(refund), 5_000e6);
        assertEq(_bal(payout), 95_000e6);
    }

    function test_TierCutoffEqualsDueDate_AtDueDateNoDiscountAndBuyerCannotCancel() public {
        uint64 due = _dueDate();
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, due, _one(due, 500), payout);
        _fund(inv, refund);
        vm.warp(due);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(_bal(payout), PRINCIPAL);
        assertEq(_bal(refund), 0);
    }

    function test_ZeroTiers_AlwaysFullPrincipal() public {
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _noTiers(), payout);
        assertEq(inv.getInvoice().tiers.length, 0);
        assertEq(inv.activeDiscount(0), 0);
        assertEq(inv.activeDiscount(T0), 0);
        assertEq(inv.activeDiscount(_dueDate()), 0);
        assertEq(inv.activeDiscount(type(uint64).max), 0);
        _fund(inv, refund);
        vm.recordLogs();
        vm.prank(buyer);
        inv.triggerPayment(); // immediately after creation: still the full principal
        assertEq(_memoLogs(vm.getRecordedLogs()).length, 1);
        assertEq(_bal(payout), PRINCIPAL);
        assertEq(_bal(refund), 0);
    }

    function test_TierPackingRoundTrip_ExtremeValues() public {
        // cutoffs / due date at uint64 max and awkward bit patterns survive storage packing
        DiscountTier[] memory t = new DiscountTier[](4);
        t[0] = DiscountTier(1, 10_000);
        t[1] = DiscountTier(0x0123456789ABCDEF, 1);
        t[2] = DiscountTier(0xFEDCBA9876543210, 9_999);
        t[3] = DiscountTier(type(uint64).max, 0x2710);
        InvoiceEscrow inv =
            _create(seller, bytes32(type(uint256).max), address(token), 1, type(uint64).max, t, address(0));
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.dueDate, type(uint64).max);
        assertEq(s.invoiceRef, bytes32(type(uint256).max));
        assertEq(s.principal, 1);
        assertEq(s.tiers.length, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(s.tiers[i].cutoff, t[i].cutoff);
            assertEq(s.tiers[i].discountBps, t[i].discountBps);
        }
        assertEq(inv.activeDiscount(0), 10_000);
        assertEq(inv.activeDiscount(1), 1);
        assertEq(inv.activeDiscount(0x0123456789ABCDEF), 9_999);
        assertEq(inv.activeDiscount(0xFEDCBA9876543210), 10_000);
        assertEq(inv.activeDiscount(type(uint64).max - 1), 10_000);
        assertEq(inv.activeDiscount(type(uint64).max), 0);
    }

    function test_TierCutoffInThePastIsAllowed_NonMonotonicBpsAllowed() public {
        // SPEC-QUESTION 4: the spec only requires strictly ascending cutoffs (first > 0), <= dueDate, bps <= 10_000.
        DiscountTier[] memory t = new DiscountTier[](3);
        t[0] = DiscountTier(1, 300); // long in the past
        t[1] = DiscountTier(T0 + 5 days, 2000); // bigger discount later
        t[2] = DiscountTier(T0 + 6 days, 100);
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), t, address(0));
        assertEq(inv.activeDiscount(0), 300);
        assertEq(inv.activeDiscount(1), 2000); // first tier whose cutoff is still ahead
        assertEq(inv.activeDiscount(T0), 2000);
        assertEq(inv.activeDiscount(T0 + 5 days), 100);
        assertEq(inv.activeDiscount(T0 + 6 days), 0);
    }

    function test_ActiveDiscount_IgnoresStatusAndCaller() public {
        InvoiceEscrow inv = _createWithPayout();
        uint16 a = inv.activeDiscount(T0);
        assertEq(a, 1500);
        _fund(inv, refund);
        vm.prank(stranger);
        assertEq(inv.activeDiscount(T0 + 15 days - 1), 1500);
        vm.prank(seller);
        inv.triggerPayment(); // Paid
        assertEq(inv.activeDiscount(T0 + 15 days - 1), 1500);
        assertEq(inv.activeDiscount(T0 + 15 days), 1000);
        assertEq(inv.activeDiscount(T0 + 30 days), 0);

        InvoiceEscrow c = _createWithPayout();
        vm.prank(seller);
        c.cancel();
        assertEq(c.activeDiscount(T0), 1500, "still answers after cancel");
    }

    function test_ActiveDiscount_UsesGivenTimestampNotBlockTimestamp() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.warp(T0 + 40 days);
        assertEq(inv.activeDiscount(T0 + 1), 1500);
        assertEq(inv.activeDiscount(T0 + 20 days), 1000);
        assertEq(inv.activeDiscount(uint64(block.timestamp)), 0);
    }

    // ═════════════════════════ payout / refund address resolution ═════════════════════════

    function test_PayoutEqualToSeller_SameAsDefault() public {
        InvoiceEscrow a = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), seller);
        InvoiceEscrow b = _createDefault();
        assertEq(a.getInvoice().payoutAddress, seller);
        assertEq(keccak256(abi.encode(a.getInvoice())), keccak256(abi.encode(b.getInvoice())));
        _fund(a, address(0));
        uint256 sellerBefore = _bal(seller);
        _warpDay(5);
        vm.prank(buyer);
        a.triggerPayment();
        assertEq(_bal(seller) - sellerBefore, 85_000e6);
    }

    function test_RefundEqualToBuyer_SameAsDefault() public {
        InvoiceEscrow a = _createWithPayout();
        InvoiceEscrow b = _createWithPayout();
        _fund(a, buyer);
        _fund(b, address(0));
        assertEq(keccak256(abi.encode(a.getInvoice())), keccak256(abi.encode(b.getInvoice())));
        assertEq(a.getInvoice().refundAddress, buyer);
        assertEq(b.getInvoice().refundAddress, buyer);
        uint256 buyerBefore = _bal(buyer);
        _warpDay(5);
        vm.prank(seller);
        a.triggerPayment();
        vm.prank(seller);
        b.triggerPayment();
        assertEq(_bal(buyer) - buyerBefore, 30_000e6);
    }

    function test_ZeroAddressPayoutAndRefundResolveIdentically_AcrossLifecycle() public {
        InvoiceEscrow inv = _createDefault();
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.payoutAddress, seller);
        assertEq(s.refundAddress, address(0), "no buyer yet");
        _fund(inv, address(0));
        s = inv.getInvoice();
        assertEq(s.payoutAddress, seller);
        assertEq(s.refundAddress, buyer);
        assertEq(s.buyer, buyer);
    }

    function test_SelfDealingAddressesAllowed() public {
        // SPEC-QUESTION 5: refund address == seller, payout address == (future) buyer are not forbidden.
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), buyer);
        _fund(inv, seller);
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.refundAddress, seller);
        assertEq(s.payoutAddress, buyer);
        uint256 sellerBefore = _bal(seller);
        uint256 buyerBefore = _bal(buyer);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(buyer) - buyerBefore, 85_000e6);
        assertEq(_bal(seller) - sellerBefore, 15_000e6);
    }

    function test_CrossPayoutAndRefund_CancelGoesToRefundNotPayout() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.warp(_dueDate() + 1);
        vm.prank(buyer);
        inv.cancel();
        assertEq(_bal(refund), PRINCIPAL);
        assertEq(_bal(payout), 0);
    }

    // ═════════════════════════ getInvoice through the lifecycle ═════════════════════════

    function test_GetInvoice_TiersKeepCreationOrderAndValues() public {
        DiscountTier[] memory t = _tiers(10);
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), t, address(0));
        _fund(inv, address(0));
        vm.prank(seller);
        inv.triggerPayment();
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.tiers.length, 10);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(s.tiers[i].cutoff, t[i].cutoff, "cutoff order");
            assertEq(s.tiers[i].discountBps, t[i].discountBps, "bps order");
        }
    }

    function test_GetInvoice_AcrossPaidLifecycle() public {
        InvoiceEscrow inv = _createWithPayout();
        InvoiceState memory s0 = inv.getInvoice();
        assertEq(uint8(s0.status), 0);

        _fund(inv, refund);
        InvoiceState memory s1 = inv.getInvoice();
        assertEq(uint8(s1.status), 1);
        assertEq(s1.buyer, buyer);
        assertEq(s1.refundAddress, refund);
        assertEq(s1.invoiceRef, s0.invoiceRef);
        assertEq(s1.seller, s0.seller);
        assertEq(s1.payoutAddress, s0.payoutAddress);
        assertEq(s1.token, s0.token);
        assertEq(s1.principal, s0.principal);
        assertEq(s1.dueDate, s0.dueDate);

        vm.prank(seller);
        inv.triggerPayment();
        InvoiceState memory s2 = inv.getInvoice();
        assertEq(uint8(s2.status), 2);
        assertEq(s2.buyer, buyer);
        assertEq(s2.refundAddress, refund);
        assertEq(s2.seller, seller);
        assertEq(s2.payoutAddress, payout);
        assertEq(s2.principal, PRINCIPAL, "principal is not zeroed by settlement");
        assertEq(s2.tiers.length, 2);

        vm.prank(stranger);
        InvoiceState memory s3 = inv.getInvoice(); // anyone can read
        assertEq(keccak256(abi.encode(s2)), keccak256(abi.encode(s3)));
    }

    function test_GetInvoice_AcrossCancelLifecycles() public {
        // unfunded cancel: buyer / refund stay zero
        InvoiceEscrow a = _createWithPayout();
        vm.prank(seller);
        a.cancel();
        InvoiceState memory s = a.getInvoice();
        assertEq(uint8(s.status), 3);
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(s.payoutAddress, payout);

        // funded cancel: buyer / refund preserved
        InvoiceEscrow b = _createWithPayout();
        _fund(b, refund);
        vm.prank(seller);
        b.cancel();
        s = b.getInvoice();
        assertEq(uint8(s.status), 3);
        assertEq(s.buyer, buyer);
        assertEq(s.refundAddress, refund);
    }

    function test_GetInvoice_NonAsciiAndOddReferences() public {
        // SPEC-QUESTION 8: the contract only rejects bytes32(0); it does not validate UTF-8.
        bytes32[3] memory refs = [bytes32(uint256(1)), bytes32(type(uint256).max), bytes32(bytes("\xc3\xa9\xe2\x82\xac-2026"))];
        for (uint256 i = 0; i < 3; i++) {
            InvoiceEscrow inv = _create(seller, refs[i], address(token), 10e6, _dueDate(), _noTiers(), payout);
            assertEq(inv.getInvoice().invoiceRef, refs[i]);
            vm.recordLogs();
            _fund(inv, refund);
            MemoLog[] memory m = _memoLogs(vm.getRecordedLogs());
            assertEq(m[0].memo, refs[i], "memo is the reference byte-for-byte");
        }
    }

    // ═════════════════════════ events ═════════════════════════

    function test_Event_Funded() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Funded(buyer, refund, PRINCIPAL);
        inv.fund(refund);
        vm.stopPrank();

        // default refund resolves to the buyer in the event
        InvoiceEscrow inv2 = _createWithPayout();
        vm.startPrank(stranger);
        token.approve(address(inv2), PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(inv2));
        emit Funded(stranger, stranger, PRINCIPAL);
        inv2.fund(address(0));
        vm.stopPrank();

        // explicit refund == buyer
        InvoiceEscrow inv3 = _createWithPayout();
        vm.startPrank(buyer);
        token.approve(address(inv3), PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(inv3));
        emit Funded(buyer, buyer, PRINCIPAL);
        inv3.fund(buyer);
        vm.stopPrank();
    }

    function test_Event_Paid_SellerAndBuyerAsCaller() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        _warpDay(20);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Paid(seller, payout, 90_000e6, refund, 10_000e6, 1000);
        vm.prank(seller);
        inv.triggerPayment();

        vm.warp(T0);
        InvoiceEscrow inv2 = _createWithPayout();
        _fund(inv2, refund);
        _warpDay(5);
        vm.expectEmit(true, false, false, true, address(inv2));
        emit Paid(buyer, payout, 85_000e6, refund, 15_000e6, 1500);
        vm.prank(buyer);
        inv2.triggerPayment();
    }

    function test_Event_Paid_NoDiscount_AddressesStillResolved() public {
        // SPEC-QUESTION 1: with refund == 0 the event still carries the resolved refund address.
        InvoiceEscrow inv = _createDefault();
        _fund(inv, address(0));
        vm.warp(_dueDate());
        vm.expectEmit(true, false, false, true, address(inv));
        emit Paid(buyer, seller, PRINCIPAL, buyer, 0, 0);
        vm.prank(buyer);
        inv.triggerPayment();
    }

    function test_Event_Cancelled() public {
        // funded, by seller
        InvoiceEscrow a = _createWithPayout();
        _fund(a, refund);
        vm.expectEmit(true, false, false, true, address(a));
        emit Cancelled(seller, PRINCIPAL);
        vm.prank(seller);
        a.cancel();

        // funded, by buyer after due date
        InvoiceEscrow b = _createWithPayout();
        _fund(b, refund);
        vm.warp(_dueDate() + 1);
        vm.expectEmit(true, false, false, true, address(b));
        emit Cancelled(buyer, PRINCIPAL);
        vm.prank(buyer);
        b.cancel();

        // unfunded: refunded == 0
        vm.warp(T0);
        InvoiceEscrow c = _createWithPayout();
        vm.expectEmit(true, false, false, true, address(c));
        emit Cancelled(seller, 0);
        vm.prank(seller);
        c.cancel();
    }

    function test_Event_OnlyExpectedEventsFromEscrow() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.recordLogs();
        _fund(inv, refund);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countFrom(logs, address(inv)), 1, "fund emits exactly Funded");

        vm.recordLogs();
        vm.prank(seller);
        inv.triggerPayment();
        logs = vm.getRecordedLogs();
        assertEq(_countFrom(logs, address(inv)), 1, "pay emits exactly Paid");
    }

    // ═════════════════════════ balances ═════════════════════════

    function test_Balances_EveryStepConservesAndEscrowEndsEmpty() public {
        InvoiceEscrow inv = _createWithPayout();
        Bals memory b0 = _snap(address(inv));
        assertEq(b0.escrow, 0);

        _fund(inv, refund);
        Bals memory b1 = _snap(address(inv));
        assertEq(b1.escrow, PRINCIPAL);
        assertEq(b0.buyer - b1.buyer, PRINCIPAL);
        assertEq(b1.seller, b0.seller);
        assertEq(b1.payout, b0.payout);
        assertEq(b1.refund, b0.refund);
        assertEq(b1.stranger, b0.stranger);
        assertEq(_total(b0), _total(b1));

        _warpDay(20);
        vm.prank(buyer);
        inv.triggerPayment();
        Bals memory b2 = _snap(address(inv));
        assertEq(b2.escrow, 0);
        assertEq(b2.payout - b1.payout, 90_000e6);
        assertEq(b2.refund - b1.refund, 10_000e6);
        assertEq(b2.buyer, b1.buyer);
        assertEq(b2.seller, b1.seller);
        assertEq(b2.stranger, b1.stranger);
        assertEq(_total(b1), _total(b2));
    }

    function test_Balances_CancelEndsEmpty() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, address(0));
        Bals memory b1 = _snap(address(inv));
        vm.prank(seller);
        inv.cancel();
        Bals memory b2 = _snap(address(inv));
        assertEq(b2.escrow, 0);
        assertEq(b2.buyer - b1.buyer, PRINCIPAL);
        assertEq(b2.payout, b1.payout);
        assertEq(b2.refund, b1.refund);
        assertEq(b2.seller, b1.seller);
        assertEq(_total(b1), _total(b2));
    }

    function test_Balances_CreateAndFailedCallsMoveNothing() public {
        Bals memory b0 = _snap(address(0));
        InvoiceEscrow inv = _createWithPayout();
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(stranger);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
        Bals memory b1 = _snap(address(inv));
        assertEq(b1.seller, b0.seller);
        assertEq(b1.buyer, b0.buyer);
        assertEq(b1.escrow, 0);
        assertEq(_bal(address(factory)), 0);
        assertEq(_bal(factory.implementation()), 0);
    }

    // ═════════════════════════ funding failures ═════════════════════════

    function test_Fund_WithoutAllowanceReverts_StateUntouched() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(buyer);
        inv.fund(refund);
        _assertStillActive(inv);

        // allowance one short
        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL - 1);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        inv.fund(refund);
        vm.stopPrank();
        _assertStillActive(inv);

        // the invoice can still be funded properly by someone else afterwards
        _fundAs(inv, stranger, address(0));
        assertEq(inv.getInvoice().buyer, stranger);
    }

    function test_Fund_InsufficientBalanceReverts_StateUntouched() public {
        address poor = makeAddr("poor");
        _mint(token, poor, PRINCIPAL - 1);
        InvoiceEscrow inv = _createWithPayout();
        vm.startPrank(poor);
        token.approve(address(inv), PRINCIPAL);
        vm.expectPartialRevert(ITIP20.InsufficientBalance.selector);
        inv.fund(refund);
        vm.stopPrank();
        _assertStillActive(inv);
        assertEq(_bal(poor), PRINCIPAL - 1);

        // exactly the principal is enough
        _mint(token, poor, 1);
        vm.prank(poor);
        inv.fund(refund);
        assertEq(_bal(poor), 0);
        assertEq(_bal(address(inv)), PRINCIPAL);
    }

    function _assertStillActive(InvoiceEscrow inv) internal view {
        InvoiceState memory s = inv.getInvoice();
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(_bal(address(inv)), 0);
    }

    function test_Fund_PullsExactlyPrincipal_NotWholeAllowance() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.startPrank(buyer);
        token.approve(address(inv), 3 * PRINCIPAL);
        inv.fund(refund);
        vm.stopPrank();
        assertEq(_bal(address(inv)), PRINCIPAL);
        assertEq(token.allowance(buyer, address(inv)), 2 * PRINCIPAL);
    }

    function test_Fund_FromContractBuyer() public {
        // the test contract itself (no EOA) can be the buyer
        _mint(token, address(this), PRINCIPAL);
        InvoiceEscrow inv = _createWithPayout();
        token.approve(address(inv), PRINCIPAL);
        inv.fund(address(0));
        assertEq(inv.getInvoice().buyer, address(this));
        assertEq(inv.getInvoice().refundAddress, address(this));
    }

    function test_Fund_AfterDueDateStillPossible() public {
        // the spec places no time limit on funding an Active invoice
        InvoiceEscrow inv = _createWithPayout();
        vm.warp(_dueDate() + 10 days);
        _fund(inv, refund);
        assertEq(uint8(_st(inv)), uint8(Status.Funded));
        vm.prank(buyer);
        inv.triggerPayment();
        assertEq(_bal(payout), PRINCIPAL);
    }

    // ═════════════════════════ state machine: all combinations ═════════════════════════

    function test_Settled_Matrix_Paid() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.prank(buyer);
        inv.triggerPayment();

        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        inv.fund(refund);
        vm.stopPrank();

        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(stranger);
        inv.fund(refund);

        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(stranger);
        inv.triggerPayment();

        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(stranger);
        inv.cancel(); // authorisation is checked before settled-ness

        assertEq(uint8(_st(inv)), uint8(Status.Paid));
        assertEq(_bal(address(inv)), 0);
    }

    function test_Settled_Matrix_CancelledUnfunded() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.prank(seller);
        inv.cancel();

        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        inv.fund(refund);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(seller); // NotActive is checked before SellerCannotFund
        inv.fund(refund);
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        inv.cancel();
        assertEq(uint8(_st(inv)), uint8(Status.Cancelled));
    }

    function test_Settled_Matrix_CancelledFunded() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.prank(seller);
        inv.cancel();

        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(buyer);
        inv.fund(refund);
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(buyer);
        inv.triggerPayment();
        vm.expectRevert(InvoiceEscrow.AlreadySettled.selector);
        vm.prank(seller);
        inv.cancel();
        assertEq(_bal(refund), PRINCIPAL, "refunded exactly once");
    }

    function test_Funded_SellerCannotFundEvenWhenFunded_NotActiveFirst() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.expectRevert(InvoiceEscrow.NotActive.selector);
        vm.prank(seller);
        inv.fund(address(0));
    }

    function test_Active_AccessChecks() public {
        InvoiceEscrow inv = _createWithPayout();
        // stranger: NotParty is checked before NotFunded
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(stranger);
        inv.triggerPayment();
        // seller: party, but not funded
        vm.expectRevert(InvoiceEscrow.NotFunded.selector);
        vm.prank(seller);
        inv.triggerPayment();
        // stranger cannot cancel, also not after the due date
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(stranger);
        inv.cancel();
        vm.warp(_dueDate() + 1);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(stranger);
        inv.cancel();
        assertEq(uint8(_st(inv)), uint8(Status.Active));
    }

    function test_ZeroAddressCaller_CannotCancelUnfundedInvoice() public {
        // buyer == address(0) before funding: address(0) must not be treated as the buyer
        InvoiceEscrow inv = _createWithPayout();
        vm.warp(_dueDate() + 1);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(address(0));
        inv.cancel();
        assertEq(uint8(_st(inv)), uint8(Status.Active));
    }

    function test_ZeroAddressCaller_TriggerPaymentUnfunded() public {
        // SPEC-QUESTION 3: address(0) is not a party, so NotParty (not NotFunded) is the expected error.
        InvoiceEscrow inv = _createWithPayout();
        vm.expectRevert(InvoiceEscrow.NotParty.selector);
        vm.prank(address(0));
        inv.triggerPayment();
    }

    function test_SellerCancelsFunded_AfterAndAtDueDate() public {
        InvoiceEscrow a = _createWithPayout();
        _fund(a, refund);
        vm.warp(_dueDate());
        vm.prank(seller);
        a.cancel();
        assertEq(_bal(refund), PRINCIPAL);

        vm.warp(T0);
        InvoiceEscrow b = _createWithPayout();
        _fund(b, refund);
        vm.warp(_dueDate() + 365 days);
        vm.prank(seller);
        b.cancel();
        assertEq(_bal(refund), 2 * PRINCIPAL);
    }

    function test_BuyerCannotCancelUnfundedByFundingTrick() public {
        // a would-be buyer who has not funded cannot cancel, even after the due date
        InvoiceEscrow inv = _createWithPayout();
        vm.warp(_dueDate() + 1);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        inv.cancel();
    }

    function test_PayAfterDueDate_ByEitherParty_AtMuchLaterTime() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.warp(type(uint64).max);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout), PRINCIPAL);
    }

    // ═════════════════════════ token-level failures (spec 3.9) ═════════════════════════

    function test_PausedToken_FundReverts_StateUntouched_ThenWorksAfterUnpause() public {
        InvoiceEscrow inv = _createWithPayout();
        vm.prank(buyer);
        token.approve(address(inv), PRINCIPAL);
        _pauseToken();
        vm.expectRevert(ITIP20.ContractPaused.selector);
        vm.prank(buyer);
        inv.fund(refund);
        _assertStillActive(inv);
        token.unpause();
        vm.prank(buyer);
        inv.fund(refund);
        assertEq(uint8(_st(inv)), uint8(Status.Funded));
    }

    function test_PausedToken_PayAndCancelRevert_StaysFunded() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        _pauseToken();
        vm.expectRevert(ITIP20.ContractPaused.selector);
        vm.prank(seller);
        inv.triggerPayment();
        vm.expectRevert(ITIP20.ContractPaused.selector);
        vm.prank(seller);
        inv.cancel();
        assertEq(uint8(_st(inv)), uint8(Status.Funded), "status must roll back with the failed transfer");
        assertEq(_bal(address(inv)), PRINCIPAL);

        token.unpause();
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(uint8(_st(inv)), uint8(Status.Paid));
        assertEq(_bal(address(inv)), 0);
    }

    function test_TokenPrefixedPayout_RevertsAtTransfer_StaysFunded() public {
        // spec 3.9: a payout address with the TIP-20 prefix makes triggerPayment revert; not checked in code
        InvoiceEscrow inv = _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), address(token));
        _fund(inv, refund);
        vm.expectRevert(ITIP20.InvalidRecipient.selector);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(uint8(_st(inv)), uint8(Status.Funded));
        assertEq(_bal(address(inv)), PRINCIPAL);
        assertEq(_bal(refund), 0, "no partial payment");
    }

    function test_TokenPrefixedRefund_CancelRevertsAndDiscountRevertsButNoDiscountPaySucceeds() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, address(token)); // fund itself does not validate the refund address
        assertEq(inv.getInvoice().refundAddress, address(token));

        vm.expectRevert(ITIP20.InvalidRecipient.selector);
        vm.prank(seller);
        inv.cancel();
        assertEq(uint8(_st(inv)), uint8(Status.Funded));

        _warpDay(5); // discount > 0 => refund transfer attempted => revert, payout rolled back too
        vm.expectRevert(ITIP20.InvalidRecipient.selector);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout), 0, "payout transfer rolled back");
        assertEq(uint8(_st(inv)), uint8(Status.Funded));

        // no discount => no refund transfer at all (skipped when refund == 0) => payment succeeds
        vm.warp(_dueDate());
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(_bal(payout), PRINCIPAL);
        assertEq(uint8(_st(inv)), uint8(Status.Paid));
    }

    // ═════════════════════════ independence ═════════════════════════

    function test_Clones_AreIndependent() public {
        InvoiceEscrow a = _createWithPayout();
        InvoiceEscrow b = _create(stranger, bytes32("OTHER"), address(token), 1_000e6, _dueDate() + 5 days, _noTiers(), address(0));
        assertTrue(address(a) != address(b));
        assertEq(a.getInvoice().seller, seller);
        assertEq(b.getInvoice().seller, stranger);
        assertEq(b.getInvoice().payoutAddress, stranger);
        assertEq(b.getInvoice().tiers.length, 0);
        assertEq(a.getInvoice().tiers.length, 2);

        // allowance given to `a` does not let `b` pull funds
        vm.prank(buyer);
        token.approve(address(a), PRINCIPAL);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(buyer);
        b.fund(address(0));

        _fund(a, refund);
        assertEq(uint8(_st(a)), uint8(Status.Funded));
        assertEq(uint8(_st(b)), uint8(Status.Active), "b untouched by funding a");
        assertEq(_bal(address(b)), 0);

        vm.prank(seller);
        a.triggerPayment();
        assertEq(uint8(_st(b)), uint8(Status.Active), "b untouched by paying a");

        // seller of `a` has no power over `b`
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(seller);
        b.cancel();
        vm.prank(stranger);
        b.cancel();
        assertEq(uint8(_st(b)), uint8(Status.Cancelled));
        assertEq(uint8(_st(a)), uint8(Status.Paid));
        assertEq(a.getInvoice().principal, PRINCIPAL);
    }

    function test_SameReferenceTwiceBySameSeller_Allowed() public {
        InvoiceEscrow a = _createWithPayout();
        InvoiceEscrow b = _createWithPayout();
        assertTrue(address(a) != address(b));
        assertEq(a.getInvoice().invoiceRef, b.getInvoice().invoiceRef);
        _fund(a, refund);
        _fund(b, refund);
        vm.prank(seller);
        a.cancel();
        assertEq(uint8(_st(b)), uint8(Status.Funded));
        vm.prank(seller);
        b.triggerPayment();
        assertEq(_bal(address(a)), 0);
        assertEq(_bal(address(b)), 0);
    }

    function test_DifferentTokensPerInvoice() public {
        ITIP20 other = _newToken("OTH", bytes32(uint256(5)));
        _mint(other, buyer, 50_000e6);
        InvoiceEscrow inv = _create(seller, REF, address(other), 50_000e6, _dueDate(), _defaultTiers(), payout);
        assertEq(inv.getInvoice().token, address(other));
        vm.startPrank(buyer);
        other.approve(address(inv), 50_000e6);
        inv.fund(refund);
        vm.stopPrank();
        uint256 mainBefore = _bal(payout);
        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(other.balanceOf(payout), 42_500e6);
        assertEq(other.balanceOf(refund), 7_500e6);
        assertEq(_bal(payout), mainBefore, "other token untouched");
        assertEq(other.balanceOf(address(inv)), 0);
    }

    function test_EscrowDoesNotHoldOtherInvoicesFunds() public {
        InvoiceEscrow a = _createWithPayout();
        InvoiceEscrow b = _createWithPayout();
        _fund(a, refund);
        _fund(b, refund);
        vm.prank(seller);
        a.cancel();
        assertEq(_bal(address(b)), PRINCIPAL);
        vm.prank(seller);
        b.cancel();
        assertEq(_bal(refund), 2 * PRINCIPAL);
    }
}
