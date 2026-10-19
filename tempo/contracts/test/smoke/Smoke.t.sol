// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {ITIP20RolesAuth} from "tempo-std/interfaces/ITIP20RolesAuth.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {StdTokens} from "tempo-std/StdTokens.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";

/// @notice The contract author's own minimal checks. The independent suite lives in test/unit and test/fork.
contract SmokeTest is Test {
    uint128 constant PRINCIPAL = 100_000e6;
    bytes32 constant REF = "INV-2026-0042";

    InvoiceFactory factory;
    ITIP20 token;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address treasury = makeAddr("treasury");
    address refundWallet = makeAddr("refundWallet");
    uint64 start;

    function setUp() public {
        factory = new InvoiceFactory();
        token = ITIP20(
            StdPrecompiles.TIP20_FACTORY.createToken("T", "T", "USD", StdTokens.PATH_USD, address(this), bytes32(0))
        );
        ITIP20RolesAuth(address(token)).grantRole(token.ISSUER_ROLE(), address(this));
        token.mint(buyer, PRINCIPAL);
        start = uint64(block.timestamp);
    }

    function _create() internal returns (InvoiceEscrow inv) {
        DiscountTier[] memory tiers = new DiscountTier[](2);
        tiers[0] = DiscountTier({cutoff: start + 15 days, discountBps: 1500});
        tiers[1] = DiscountTier({cutoff: start + 30 days, discountBps: 1000});
        vm.prank(seller);
        inv = InvoiceEscrow(
            factory.createInvoice(REF, address(token), PRINCIPAL, start + 60 days, tiers, treasury)
        );
    }

    function _fund(InvoiceEscrow inv, address refundTo) internal {
        vm.startPrank(buyer);
        token.approve(address(inv), PRINCIPAL);
        inv.fund(refundTo);
        vm.stopPrank();
    }

    function test_createAndRead() public {
        InvoiceEscrow inv = _create();
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.seller, seller);
        assertEq(s.payoutAddress, treasury);
        assertEq(s.buyer, address(0));
        assertEq(s.refundAddress, address(0));
        assertEq(s.tiers.length, 2);
        assertEq(s.tiers[1].cutoff, start + 30 days);
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(inv.activeDiscount(start + 1), 1500);
        assertEq(inv.activeDiscount(start + 15 days), 1000);
        assertEq(inv.activeDiscount(start + 30 days), 0);
    }

    function test_payInFirstTier() public {
        InvoiceEscrow inv = _create();
        _fund(inv, refundWallet);
        vm.warp(start + 5 days);
        vm.expectEmit(address(token));
        emit ITIP20.TransferWithMemo(address(inv), treasury, 85_000e6, REF);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(token.balanceOf(treasury), 85_000e6);
        assertEq(token.balanceOf(refundWallet), 15_000e6);
        assertEq(token.balanceOf(address(inv)), 0);
    }

    function test_cancelFundedRefunds() public {
        InvoiceEscrow inv = _create();
        _fund(inv, address(0));
        vm.prank(seller);
        inv.cancel();
        assertEq(token.balanceOf(buyer), PRINCIPAL);
    }

    function test_directInitializeReverts() public {
        InvoiceEscrow inv = _create();
        DiscountTier[] memory none = new DiscountTier[](0);
        vm.expectRevert(InvoiceEscrow.NotFactory.selector);
        inv.initialize(seller, REF, address(token), PRINCIPAL, start + 1 days, none, address(0));
    }

    function test_nonTip20Rejected() public {
        DiscountTier[] memory none = new DiscountTier[](0);
        vm.expectRevert(InvoiceEscrow.NotTIP20.selector);
        factory.createInvoice(REF, address(0xBEEF), PRINCIPAL, start + 1 days, none, address(0));
    }
}
