// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";

/// @notice Factory behaviour, `initialize` called directly, and validation precedence.
contract InvoiceFactoryTest is Base {
    // ═════════════════════════ factory wiring ═════════════════════════

    function test_Factory_ImplementationWiring() public {
        address impl = factory.implementation();
        assertTrue(impl.code.length > 0, "implementation deployed");
        assertEq(InvoiceEscrow(impl).factory(), address(factory), "implementation.factory == factory");

        InvoiceEscrow inv = _createDefault();
        assertEq(inv.factory(), address(factory), "clones see the factory immutable through the proxy");
        assertTrue(address(inv) != impl);
    }

    function test_Factory_CloneIsEIP1167PointingAtImplementation() public {
        InvoiceEscrow inv = _createDefault();
        bytes memory expected = abi.encodePacked(
            hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
        );
        assertEq(address(inv).code.length, 45, "minimal proxy runtime code is 45 bytes");
        assertEq(address(inv).code, expected);
    }

    function test_Factory_TwoFactoriesDoNotShareImplementationOrAuthority() public {
        InvoiceFactory f2 = new InvoiceFactory();
        assertTrue(f2.implementation() != factory.implementation());
        vm.prank(seller);
        InvoiceEscrow inv2 = InvoiceEscrow(
            f2.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), address(0))
        );
        assertEq(inv2.factory(), address(f2));
        DiscountTier[] memory tiers = _defaultTiers();
        // the first factory is not the authority of a clone made by the second one
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(address(factory));
        inv2.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        // the second factory is, but the clone is already initialised
        vm.expectRevert(InvoiceEscrow.AlreadyInitialized.selector);
        vm.prank(address(f2));
        inv2.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
    }

    function test_Factory_EmitsExactlyOneLog_InvoiceCreated() public {
        vm.recordLogs();
        vm.prank(seller);
        address inv = factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "the clone's initialize emits nothing; only InvoiceCreated");
        assertEq(logs[0].emitter, address(factory));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], InvoiceCreated.selector);
        assertEq(address(uint160(uint256(logs[0].topics[1]))), inv, "indexed invoice");
        assertEq(address(uint160(uint256(logs[0].topics[2]))), seller, "indexed seller");
        assertEq(logs[0].topics[3], REF, "indexed invoiceRef");
        (address tok, uint128 principal, uint64 due) = abi.decode(logs[0].data, (address, uint128, uint64));
        assertEq(tok, address(token));
        assertEq(principal, PRINCIPAL);
        assertEq(due, _dueDate());
    }

    function test_Factory_CallerBecomesSeller_EvenForContractCallers() public {
        // no prank: the test contract itself is the seller
        address inv = factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _noTiers(), address(0));
        assertEq(InvoiceEscrow(inv).getInvoice().seller, address(this));
        assertEq(InvoiceEscrow(inv).getInvoice().payoutAddress, address(this));
    }

    function test_Factory_ManyInvoices_DistinctAddressesAndIndependentState() public {
        address[5] memory invs;
        for (uint256 i = 0; i < 5; i++) {
            invs[i] = address(
                _create(seller, bytes32(uint256(i + 1)), address(token), uint128((i + 1) * 1_000e6), _dueDate(), _tiers(i), address(0))
            );
            for (uint256 j = 0; j < i; j++) {
                assertTrue(invs[i] != invs[j]);
            }
        }
        for (uint256 i = 0; i < 5; i++) {
            InvoiceState memory s = InvoiceEscrow(invs[i]).getInvoice();
            assertEq(s.invoiceRef, bytes32(uint256(i + 1)));
            assertEq(s.principal, uint128((i + 1) * 1_000e6));
            assertEq(s.tiers.length, i);
        }
    }

    function test_Factory_FailedCreateLeavesNoClone() public {
        uint256 nonceBefore = vm.getNonce(address(factory));
        address predicted = vm.computeCreateAddress(address(factory), nonceBefore);

        vm.expectRevert(InvoiceEscrow.NotTIP20.selector);
        vm.prank(seller);
        factory.createInvoice(REF, UNPREFIXED, PRINCIPAL, _dueDate(), _defaultTiers(), address(0));

        assertEq(vm.getNonce(address(factory)), nonceBefore, "the whole transaction reverted, no clone deployed");
        assertEq(predicted.code.length, 0);

        vm.prank(seller);
        address inv = factory.createInvoice(REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), address(0));
        assertEq(inv, predicted);
    }

    function test_Factory_AcceptsSeveralRealTokens() public {
        InvoiceEscrow inv = _create(seller, REF, address(_newToken("TWO", bytes32(uint256(9)))), 5, _dueDate(), _noTiers(), address(0));
        assertTrue(inv.getInvoice().token != address(token));
    }

    // ═════════════════════════ validation precedence (all through the factory) ═════════════════════════

    function _eleven() internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](11);
        for (uint256 i = 0; i < 11; i++) {
            t[i] = DiscountTier(5, 20_000); // non-ascending, oversized: every tier is wrong
        }
    }

    function _revertsWith(
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

    function test_ValidationOrder_FollowsNatSpec() public {
        uint64 due = _dueDate();
        uint64 past = T0 - 1;

        // everything wrong -> first check wins
        _revertsWith(InvoiceEscrow.EmptyInvoiceRef.selector, bytes32(0), UNPREFIXED, 0, past, _eleven());
        // ref ok
        _revertsWith(InvoiceEscrow.InvalidPrincipal.selector, REF, UNPREFIXED, 0, past, _eleven());
        // principal ok
        _revertsWith(InvoiceEscrow.DueDateNotInFuture.selector, REF, UNPREFIXED, 1, past, _eleven());
        // due date ok
        _revertsWith(InvoiceEscrow.TooManyTiers.selector, REF, UNPREFIXED, 1, due, _eleven());

        // tier count ok: within one tier, ascending is checked before due date, before bps
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(0, 20_000);
        _revertsWith(InvoiceEscrow.TiersNotAscending.selector, REF, UNPREFIXED, 1, due, t);
        t[0] = DiscountTier(due + 1, 20_000);
        _revertsWith(InvoiceEscrow.TierAfterDueDate.selector, REF, UNPREFIXED, 1, due, t);
        t[0] = DiscountTier(due, 20_000);
        _revertsWith(InvoiceEscrow.DiscountTooLarge.selector, REF, UNPREFIXED, 1, due, t);

        // all tiers fine -> token is checked last
        t[0] = DiscountTier(due, 10_000);
        _revertsWith(InvoiceEscrow.NotTIP20.selector, REF, UNPREFIXED, 1, due, t);
    }

    function test_ValidationOrder_TierChecksAreInterleavedPerTier() public {
        // SPEC-QUESTION 6: NatSpec says "for each tier, in order, and for each tier in this order". Read as one
        // pass over the tiers applying the three checks to each tier before moving to the next.
        uint64 due = _dueDate();
        DiscountTier[] memory t = new DiscountTier[](2);

        // tier 0 has an oversized bps; tier 1 is not ascending -> tier 0's error comes first
        t[0] = DiscountTier(T0 + 10, 10_001);
        t[1] = DiscountTier(T0 + 10, 100);
        _revertsWith(InvoiceEscrow.DiscountTooLarge.selector, REF, address(token), 1, due, t);

        // tier 0 is after the due date; tier 1 not ascending
        t[0] = DiscountTier(due + 1, 100);
        t[1] = DiscountTier(due, 100);
        _revertsWith(InvoiceEscrow.TierAfterDueDate.selector, REF, address(token), 1, due, t);

        // tier 0 fine; tier 1 not ascending; tier 2 oversized
        DiscountTier[] memory t3 = new DiscountTier[](3);
        t3[0] = DiscountTier(T0 + 10, 100);
        t3[1] = DiscountTier(T0 + 10, 100);
        t3[2] = DiscountTier(T0 + 20, 10_001);
        _revertsWith(InvoiceEscrow.TiersNotAscending.selector, REF, address(token), 1, due, t3);

        // tier 0, 1 fine; tier 2 oversized and tier 3 after the due date -> oversized first
        DiscountTier[] memory t4 = new DiscountTier[](4);
        t4[0] = DiscountTier(T0 + 10, 100);
        t4[1] = DiscountTier(T0 + 20, 100);
        t4[2] = DiscountTier(T0 + 30, 10_001);
        t4[3] = DiscountTier(due + 5, 100);
        _revertsWith(InvoiceEscrow.DiscountTooLarge.selector, REF, address(token), 1, due, t4);
    }

    function test_ValidationBoundaries_AcceptedJustInside() public {
        // dueDate == now + 1, first cutoff == 1, tier cutoff == dueDate, bps == 10_000, principal == 1
        DiscountTier[] memory t = new DiscountTier[](1);
        t[0] = DiscountTier(T0 + 1, 10_000);
        InvoiceEscrow inv = _create(seller, REF, address(token), 1, T0 + 1, t, address(0));
        assertEq(inv.getInvoice().dueDate, T0 + 1);
        assertEq(inv.getInvoice().principal, 1);
    }

    // ═════════════════════════ initialize called directly ═════════════════════════

    function _freshClone() internal returns (InvoiceEscrow) {
        return InvoiceEscrow(Clones.clone(factory.implementation()));
    }

    function test_Initialize_UninitializedClone_OnlyFactoryMay() public {
        InvoiceEscrow c = _freshClone();
        DiscountTier[] memory tiers = _defaultTiers();

        // NotFactory takes precedence over everything, including invalid arguments
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(stranger);
        c.initialize(stranger, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        vm.prank(stranger);
        c.initialize(stranger, bytes32(0), address(0), 0, 0, tiers, address(0));
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0)); // test contract

        // the factory address may initialise it, with the seller it is told about
        vm.recordLogs();
        vm.prank(address(factory));
        c.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, payout);
        assertEq(vm.getRecordedLogs().length, 0, "initialize emits no event");

        InvoiceState memory s = c.getInvoice();
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, payout);
        assertEq(s.invoiceRef, REF);
        assertEq(s.token, address(token));
        assertEq(s.principal, PRINCIPAL);
        assertEq(s.dueDate, _dueDate());
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(s.tiers.length, 2);

        // and exactly once
        vm.expectRevert(InvoiceEscrow.AlreadyInitialized.selector);
        vm.prank(address(factory));
        c.initialize(buyer, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        assertEq(c.getInvoice().seller, seller, "second init did not overwrite");
    }

    function test_Initialize_DirectValidationErrors() public {
        InvoiceEscrow c = _freshClone();
        uint64 due = _dueDate();
        DiscountTier[] memory ok = _defaultTiers();
        DiscountTier[] memory t = new DiscountTier[](1);

        // each failure reverts the whole call, so the clone stays uninitialised and the next check still reaches
        // the validations (not AlreadyInitialized)
        vm.startPrank(address(factory));
        vm.expectRevert(InvoiceEscrow.EmptyInvoiceRef.selector);
        c.initialize(seller, bytes32(0), address(token), PRINCIPAL, due, ok, address(0));
        vm.expectRevert(InvoiceEscrow.InvalidPrincipal.selector);
        c.initialize(seller, REF, address(token), 0, due, ok, address(0));
        vm.expectRevert(InvoiceEscrow.DueDateNotInFuture.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, T0, ok, address(0));
        vm.expectRevert(InvoiceEscrow.TooManyTiers.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, due, _tiers(11), address(0));
        t[0] = DiscountTier(0, 1);
        vm.expectRevert(InvoiceEscrow.TiersNotAscending.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, due, t, address(0));
        t[0] = DiscountTier(due + 1, 1);
        vm.expectRevert(InvoiceEscrow.TierAfterDueDate.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, due, t, address(0));
        t[0] = DiscountTier(due, 10_001);
        vm.expectRevert(InvoiceEscrow.DiscountTooLarge.selector);
        c.initialize(seller, REF, address(token), PRINCIPAL, due, t, address(0));
        vm.expectRevert(InvoiceEscrow.NotTIP20.selector);
        c.initialize(seller, REF, UNPREFIXED, PRINCIPAL, due, ok, address(0));
        vm.expectRevert(InvoiceEscrow.NotTIP20.selector);
        c.initialize(seller, REF, PREFIXED_NO_CODE, PRINCIPAL, due, ok, address(0));
        // after all those failures the clone can still be initialised
        c.initialize(seller, REF, address(token), PRINCIPAL, due, ok, address(0));
        vm.stopPrank();
        assertEq(c.getInvoice().seller, seller);
    }

    function test_Initialize_PayoutEqualToSellerResolvesToSeller() public {
        InvoiceEscrow c = _freshClone();
        vm.prank(address(factory));
        c.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), _noTiers(), seller);
        assertEq(c.getInvoice().payoutAddress, seller);
        InvoiceEscrow c2 = _freshClone();
        vm.prank(address(factory));
        c2.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), _noTiers(), address(0));
        assertEq(c2.getInvoice().payoutAddress, seller);
    }

    function test_Initialize_ImplementationCannotBeInitialisedByAnyone() public {
        InvoiceEscrow impl = InvoiceEscrow(factory.implementation());
        DiscountTier[] memory tiers = _defaultTiers();
        address[4] memory callers = [address(factory), stranger, seller, address(this)];
        for (uint256 i = 0; i < 4; i++) {
            bytes4 expected = callers[i] == address(factory)
                ? InvoiceEscrow.AlreadyInitialized.selector
                : InvoiceEscrow.NotFactory.selector;
            vm.expectRevert(expected);
            vm.prank(callers[i]);
            impl.initialize(seller, REF, address(token), PRINCIPAL, _dueDate(), tiers, address(0));
        }
    }
}
