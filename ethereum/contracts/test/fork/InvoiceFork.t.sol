// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Runs only under `FOUNDRY_PROFILE=fork` against Sepolia, with the real PYUSD and USDC contracts.
///         `SEPOLIA_RPC_URL=<url> FOUNDRY_PROFILE=fork forge test`
contract InvoiceForkTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Funded(address indexed buyer, bytes32 indexed invoiceRef, address refundAddress, uint128 principal);
    event Paid(
        address indexed caller,
        bytes32 indexed invoiceRef,
        address payoutAddress,
        uint128 toSeller,
        address refundAddress,
        uint128 refundToBuyer,
        uint16 discountBps
    );
    event Cancelled(address indexed caller, bytes32 indexed invoiceRef, uint128 refunded);
    event SettledDirect(
        address indexed caller, bytes32 indexed invoiceRef, address payoutAddress, uint256 amount, uint16 discountBps
    );
    event InvoiceCreated(
        address indexed invoice,
        address indexed seller,
        bytes32 indexed invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate
    );

    address internal constant PYUSD = 0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9;
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    /// @dev An address that holds no code on Sepolia.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes32 internal constant REF = bytes32("INV-2026-0042");
    uint128 internal constant PRINCIPAL = 10_000e6;

    InvoiceFactory internal factory;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal payout = makeAddr("payout");
    address internal refund = makeAddr("refund");
    address internal stranger = makeAddr("stranger");

    uint64 internal t0;
    uint64 internal due;

    function setUp() public {
        t0 = uint64(block.timestamp);
        due = t0 + 60 days;
        factory = new InvoiceFactory();
        // `deal` works on both proxies (verification notes item 5)
        deal(PYUSD, buyer, 10 * PRINCIPAL);
        deal(USDC, buyer, 10 * PRINCIPAL);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _tiers() internal view returns (DiscountTier[] memory t) {
        t = new DiscountTier[](2);
        t[0] = DiscountTier(t0 + 15 days, 1500);
        t[1] = DiscountTier(t0 + 30 days, 1000);
    }

    function _create(address tok, address payoutAddress) internal returns (InvoiceEscrow) {
        vm.prank(seller);
        return InvoiceEscrow(factory.createInvoice(REF, tok, PRINCIPAL, due, _tiers(), payoutAddress));
    }

    function _fund(InvoiceEscrow inv, address tok, address refundAddress) internal {
        vm.startPrank(buyer);
        IERC20(tok).approve(address(inv), PRINCIPAL);
        inv.fund(refundAddress);
        vm.stopPrank();
    }

    function _expectTransfer(address tok, address from, address to, uint256 amount) internal {
        vm.expectEmit(true, true, false, true, tok);
        emit Transfer(from, to, amount);
    }

    // ───────────────────────── lifecycle against the real tokens ─────────────────────────

    function _lifecycle(address tok) internal {
        IERC20 erc = IERC20(tok);
        assertEq(IERC20Metadata(tok).decimals(), 6, "6-decimal token");

        // create
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit InvoiceCreated(predicted, seller, REF, tok, PRINCIPAL, due);
        InvoiceEscrow inv = _create(tok, payout);
        assertEq(address(inv), predicted);
        assertEq(inv.getInvoice().token, tok);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Active));

        // fund
        uint256 buyerBefore = erc.balanceOf(buyer);
        vm.startPrank(buyer);
        erc.approve(address(inv), PRINCIPAL);
        _expectTransfer(tok, buyer, address(inv), PRINCIPAL);
        vm.expectEmit(true, true, false, true, address(inv));
        emit Funded(buyer, REF, refund, PRINCIPAL);
        inv.fund(refund);
        vm.stopPrank();
        assertEq(erc.balanceOf(address(inv)), PRINCIPAL);
        assertEq(buyerBefore - erc.balanceOf(buyer), PRINCIPAL);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Funded));

        // pay on day 5: 15% back to the refund address
        vm.warp(t0 + 5 days);
        _expectTransfer(tok, address(inv), payout, 8_500e6);
        _expectTransfer(tok, address(inv), refund, 1_500e6);
        vm.expectEmit(true, true, false, true, address(inv));
        emit Paid(seller, REF, payout, 8_500e6, refund, 1_500e6, 1500);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(erc.balanceOf(payout), 8_500e6);
        assertEq(erc.balanceOf(refund), 1_500e6);
        assertEq(erc.balanceOf(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));

        // second invoice: pay in the second tier, by the buyer
        vm.warp(t0);
        InvoiceEscrow b = _create(tok, payout);
        _fund(b, tok, address(0));
        uint256 buyerAfterFund = erc.balanceOf(buyer);
        vm.warp(t0 + 20 days);
        vm.prank(buyer);
        b.triggerPayment();
        assertEq(erc.balanceOf(payout), 8_500e6 + 9_000e6);
        assertEq(erc.balanceOf(buyer) - buyerAfterFund, 1_000e6, "discount to the buyer's own address");
        assertEq(erc.balanceOf(address(b)), 0);

        // third invoice: cancelled by the seller after funding
        vm.warp(t0);
        InvoiceEscrow c = _create(tok, payout);
        _fund(c, tok, refund);
        uint256 refundBefore = erc.balanceOf(refund);
        _expectTransfer(tok, address(c), refund, PRINCIPAL);
        vm.expectEmit(true, true, false, true, address(c));
        emit Cancelled(seller, REF, PRINCIPAL);
        vm.prank(seller);
        c.cancel();
        assertEq(erc.balanceOf(refund) - refundBefore, PRINCIPAL);
        assertEq(erc.balanceOf(address(c)), 0);
        assertEq(uint8(c.getInvoice().status), uint8(Status.Cancelled));

        // fourth invoice: cancelled by the buyer, only after the due date
        InvoiceEscrow d = _create(tok, payout);
        _fund(d, tok, address(0));
        vm.warp(due);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        d.cancel();
        vm.warp(due + 1);
        uint256 buyerBeforeCancel = erc.balanceOf(buyer);
        vm.prank(buyer);
        d.cancel();
        assertEq(erc.balanceOf(buyer) - buyerBeforeCancel, PRINCIPAL);
        assertEq(erc.balanceOf(address(d)), 0);
    }

    function test_Fork_PyusdLifecycle() public {
        _lifecycle(PYUSD);
    }

    function test_Fork_UsdcLifecycle() public {
        _lifecycle(USDC);
    }

    function _settleDirect(address tok) internal {
        IERC20 erc = IERC20(tok);
        InvoiceEscrow inv = _create(tok, payout);
        vm.warp(t0 + 5 days);

        // a plain transfer into the clone, one unit short of the amount due (85%)
        vm.prank(buyer);
        erc.transfer(address(inv), 8_500e6 - 1);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, 8_500e6 - 1, 8_500e6));
        vm.prank(stranger);
        inv.settleDirect();

        vm.prank(buyer);
        erc.transfer(address(inv), 1);
        _expectTransfer(tok, address(inv), payout, 8_500e6);
        vm.expectEmit(true, true, false, true, address(inv));
        emit SettledDirect(stranger, REF, payout, 8_500e6, 1500);
        vm.prank(stranger);
        inv.settleDirect();
        assertEq(erc.balanceOf(payout), 8_500e6);
        assertEq(erc.balanceOf(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_Fork_PyusdSettleDirect() public {
        _settleDirect(PYUSD);
    }

    function test_Fork_UsdcSettleDirect() public {
        _settleDirect(USDC);
    }

    function test_Fork_FullDiscount_ZeroAmountPayoutTransfer() public {
        // verification notes item 2b: a zero-amount transfer succeeds on the real tokens, so a 100% discount settles
        address[2] memory toks = [PYUSD, USDC];
        for (uint256 i = 0; i < 2; i++) {
            DiscountTier[] memory t = new DiscountTier[](1);
            t[0] = DiscountTier(t0 + 10 days, 10_000);
            vm.prank(seller);
            InvoiceEscrow inv = InvoiceEscrow(factory.createInvoice(REF, toks[i], PRINCIPAL, due, t, payout));
            _fund(inv, toks[i], refund);
            _expectTransfer(toks[i], address(inv), payout, 0);
            _expectTransfer(toks[i], address(inv), refund, PRINCIPAL);
            vm.prank(seller);
            inv.triggerPayment();
            assertEq(IERC20(toks[i]).balanceOf(payout), 0);
            assertEq(IERC20(toks[i]).balanceOf(refund), PRINCIPAL);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        }
    }

    // ───────────────────────── InvalidToken against real addresses ─────────────────────────

    function _expectInvalidToken(address tok) internal {
        vm.expectRevert(InvoiceEscrow.InvalidToken.selector);
        vm.prank(seller);
        factory.createInvoice(REF, tok, PRINCIPAL, due, _tiers(), address(0));
    }

    function test_Fork_InvalidToken_EOAAndEmptyAddresses() public {
        assertEq(DEAD.code.length, 0, "sanity: the dead address has no code on Sepolia");
        _expectInvalidToken(address(0));
        _expectInvalidToken(DEAD);
        _expectInvalidToken(buyer); // an EOA
        _expectInvalidToken(seller);
        _expectInvalidToken(makeAddr("anotherEoa"));
    }

    function test_Fork_CreationOnlyChecksCode() public {
        // creation only checks that the address has code: the factory (a contract, not a token) is accepted
        assertTrue(PYUSD.code.length > 0 && USDC.code.length > 0);
        InvoiceEscrow inv = _create(address(factory), address(0));
        assertEq(inv.getInvoice().token, address(factory));
        assertEq(_create(PYUSD, address(0)).getInvoice().token, PYUSD);
        assertEq(_create(USDC, address(0)).getInvoice().token, USDC);
    }

    // ───────────────────────── gas ─────────────────────────

    function _tiersN(uint256 n) internal view returns (DiscountTier[] memory t) {
        t = new DiscountTier[](n);
        for (uint256 i = 0; i < n; i++) {
            t[i] = DiscountTier(t0 + uint64((i + 1) * 1 days), uint16(100 * (n - i)));
        }
    }

    /// @dev Gas of one `createInvoice` call (measured around the call; includes the clone, initialisation and
    ///      the event). Logged rather than written to `snapshots/`, which is outside `test/`.
    function _gasCreate(string memory label, uint256 n) internal returns (uint256 used) {
        DiscountTier[] memory tiers = _tiersN(n);
        vm.prank(seller);
        uint256 g0 = gasleft();
        factory.createInvoice(REF, PYUSD, PRINCIPAL, due, tiers, payout);
        used = g0 - gasleft();
        console.log(label, used);
    }

    function test_Fork_Gas_CreateInvoice_ZeroTiers() public {
        uint256 g = _gasCreate("createInvoice_0_tiers", 0);
        assertLt(g, 2_000_000, "sanity bound");
    }

    function test_Fork_Gas_CreateInvoice_ThreeTiers() public {
        uint256 g = _gasCreate("createInvoice_3_tiers", 3);
        assertLt(g, 2_000_000, "sanity bound");
    }

    function test_Fork_Gas_CreateInvoice_TenTiers() public {
        uint256 g = _gasCreate("createInvoice_10_tiers", 10);
        assertLt(g, 2_000_000, "sanity bound");
    }

    function test_Fork_Gas_MoreTiersCostMore() public {
        uint256 g0 = _gasCreate("createInvoice_0_tiers", 0);
        uint256 g3 = _gasCreate("createInvoice_3_tiers", 3);
        uint256 g10 = _gasCreate("createInvoice_10_tiers", 10);
        assertLt(g0, g3);
        assertLt(g3, g10);
    }
}
