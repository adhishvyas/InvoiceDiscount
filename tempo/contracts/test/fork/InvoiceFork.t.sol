// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {StdTokens} from "tempo-std/StdTokens.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";

/// @notice Runs only under `FOUNDRY_PROFILE=fork` against Moderato, with the live token set.
contract InvoiceForkTest is Test {
    event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo);
    event Funded(address indexed buyer, address refundAddress, uint128 principal);
    event Paid(
        address indexed caller,
        address payoutAddress,
        uint128 toSeller,
        address refundAddress,
        uint128 refundToBuyer,
        uint16 discountBps
    );
    event Cancelled(address indexed caller, uint128 refunded);
    event InvoiceCreated(
        address indexed invoice,
        address indexed seller,
        bytes32 indexed invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate
    );

    address internal constant HOLDER = 0xA6C5691eB8Fa9e84cCaB01DdAd6BD0Ce5188716d;
    address internal constant ALPHA_USD = 0x20C0000000000000000000000000000000000001;
    address internal constant OUSD = 0x20c0000000000000000000006a37DA5C996874BE;
    address internal constant DEX = 0xDEc0000000000000000000000000000000000000;
    /// @dev TIP-20 prefix, but no token was created here (verified in `setUp`).
    address internal constant PREFIXED_NO_CODE = 0x20C0000000000000000000000000000000FffFFf;

    bytes32 internal constant REF = bytes32("INV-2026-0042");
    uint128 internal constant PRINCIPAL = 10_000e6;

    InvoiceFactory internal factory;
    ITIP20 internal alpha = ITIP20(ALPHA_USD);

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
        require(
            PREFIXED_NO_CODE.code.length == 0, "fork: the prefixed no-code test address unexpectedly has code on Moderato"
        );
        _fundFromHolder(alpha, buyer, 3 * PRINCIPAL);
    }

    // ───────────────────────── helpers ─────────────────────────

    /// @dev `deal` does not work on TIP-20 balances; move tokens from the funded address instead.
    function _fundFromHolder(ITIP20 tok, address to, uint256 amount) internal {
        uint256 held = tok.balanceOf(HOLDER);
        require(
            held >= amount,
            string.concat(
                "fork: holder 0xA6C5...716d has too little of the token (need more than it holds); ",
                "refill with `cast rpc tempo_fundAddress <addr> --rpc-url https://rpc.moderato.tempo.xyz`"
            )
        );
        vm.prank(HOLDER);
        tok.transfer(to, amount);
    }

    function _tiers() internal view returns (DiscountTier[] memory t) {
        t = new DiscountTier[](2);
        t[0] = DiscountTier(t0 + 15 days, 1500);
        t[1] = DiscountTier(t0 + 30 days, 1000);
    }

    function _create(address tok, DiscountTier[] memory tiers, address payoutAddress) internal returns (InvoiceEscrow) {
        vm.prank(seller);
        return InvoiceEscrow(factory.createInvoice(REF, tok, PRINCIPAL, due, tiers, payoutAddress));
    }

    function _fund(InvoiceEscrow inv, ITIP20 tok, address refundAddress) internal {
        vm.startPrank(buyer);
        tok.approve(address(inv), PRINCIPAL);
        inv.fund(refundAddress);
        vm.stopPrank();
    }

    // ───────────────────────── happy path with real memo events ─────────────────────────

    function test_Fork_HappyPath_AlphaUSD() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit InvoiceCreated(predicted, seller, REF, ALPHA_USD, PRINCIPAL, due);
        InvoiceEscrow inv = _create(ALPHA_USD, _tiers(), payout);
        assertEq(address(inv), predicted);
        assertEq(inv.getInvoice().token, ALPHA_USD);

        // fund, with the real TransferWithMemo event
        uint256 buyerBefore = alpha.balanceOf(buyer);
        vm.startPrank(buyer);
        alpha.approve(address(inv), PRINCIPAL);
        vm.expectEmit(true, true, true, true, ALPHA_USD);
        emit TransferWithMemo(buyer, address(inv), PRINCIPAL, REF);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Funded(buyer, refund, PRINCIPAL);
        inv.fund(refund);
        vm.stopPrank();
        assertEq(alpha.balanceOf(address(inv)), PRINCIPAL);
        assertEq(buyerBefore - alpha.balanceOf(buyer), PRINCIPAL);

        // pay on day 5: 15% back to the refund address
        vm.warp(t0 + 5 days);
        vm.expectEmit(true, true, true, true, ALPHA_USD);
        emit TransferWithMemo(address(inv), payout, 8_500e6, REF);
        vm.expectEmit(true, true, true, true, ALPHA_USD);
        emit TransferWithMemo(address(inv), refund, 1_500e6, REF);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Paid(seller, payout, 8_500e6, refund, 1_500e6, 1500);
        vm.prank(seller);
        inv.triggerPayment();

        assertEq(alpha.balanceOf(payout), 8_500e6);
        assertEq(alpha.balanceOf(refund), 1_500e6);
        assertEq(alpha.balanceOf(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
    }

    function test_Fork_Cancel_AlphaUSD_RefundsWithMemo() public {
        InvoiceEscrow inv = _create(ALPHA_USD, _tiers(), payout);
        _fund(inv, alpha, refund);
        vm.expectEmit(true, true, true, true, ALPHA_USD);
        emit TransferWithMemo(address(inv), refund, PRINCIPAL, REF);
        vm.expectEmit(true, false, false, true, address(inv));
        emit Cancelled(seller, PRINCIPAL);
        vm.prank(seller);
        inv.cancel();
        assertEq(alpha.balanceOf(refund), PRINCIPAL);
        assertEq(alpha.balanceOf(payout), 0);
        assertEq(alpha.balanceOf(address(inv)), 0);
        assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
    }

    function test_Fork_BuyerCancelsAfterDueDate_NoDiscountPay_AtBoundary() public {
        InvoiceEscrow a = _create(ALPHA_USD, _tiers(), payout);
        _fund(a, alpha, address(0));
        vm.warp(due);
        vm.expectRevert(InvoiceEscrow.NotAuthorizedToCancel.selector);
        vm.prank(buyer);
        a.cancel();
        vm.warp(due + 1);
        uint256 buyerBefore = alpha.balanceOf(buyer);
        vm.prank(buyer);
        a.cancel();
        assertEq(alpha.balanceOf(buyer) - buyerBefore, PRINCIPAL);

        // exactly at the second cutoff the payment is undiscounted
        vm.warp(t0);
        InvoiceEscrow b = _create(ALPHA_USD, _tiers(), payout);
        _fund(b, alpha, refund);
        vm.warp(t0 + 30 days);
        vm.prank(buyer);
        b.triggerPayment();
        assertEq(alpha.balanceOf(payout), PRINCIPAL);
        assertEq(alpha.balanceOf(refund), 0);
    }

    // ───────────────────────── NotTIP20 against real addresses ─────────────────────────

    function _expectNotTIP20(address tok) internal {
        vm.expectRevert(InvoiceEscrow.NotTIP20.selector);
        vm.prank(seller);
        factory.createInvoice(REF, tok, PRINCIPAL, due, _tiers(), address(0));
    }

    function test_Fork_NotTIP20_DexPrecompile() public {
        assertTrue(DEX.code.length > 0, "the DEX precompile has code but is not a TIP-20");
        _expectNotTIP20(DEX);
    }

    function test_Fork_NotTIP20_PrefixedAddressWithoutCode() public {
        assertEq(PREFIXED_NO_CODE.code.length, 0);
        _expectNotTIP20(PREFIXED_NO_CODE);
    }

    function test_Fork_NotTIP20_OtherRealAddresses() public {
        _expectNotTIP20(address(0));
        _expectNotTIP20(HOLDER); // an EOA with a balance
        _expectNotTIP20(StdPrecompiles.TIP20_FACTORY_ADDRESS); // a precompile with a 0x20Fc prefix, not 0x20C0
        _expectNotTIP20(StdPrecompiles.TIP_FEE_MANAGER_ADDRESS);
        _expectNotTIP20(address(factory)); // a real contract
    }

    // ───────────────────────── other live tokens ─────────────────────────

    function test_Fork_OUSD_Accepted() public {
        assertTrue(StdPrecompiles.TIP20_FACTORY.isTIP20(OUSD), "sanity: OUSD is a TIP-20 on Moderato");
        InvoiceEscrow inv = _create(OUSD, _tiers(), payout);
        InvoiceState memory s = inv.getInvoice();
        assertEq(s.token, OUSD);
        assertEq(s.principal, PRINCIPAL);
        assertEq(s.seller, seller);

        // the whole flow, if the funded address holds OUSD
        ITIP20 ousd = ITIP20(OUSD);
        if (ousd.balanceOf(HOLDER) >= PRINCIPAL) {
            _fundFromHolder(ousd, buyer, PRINCIPAL);
            _fund(inv, ousd, refund);
            vm.warp(t0 + 20 days);
            vm.expectEmit(true, true, true, true, OUSD);
            emit TransferWithMemo(address(inv), payout, 9_000e6, REF);
            vm.prank(buyer);
            inv.triggerPayment();
            assertEq(ousd.balanceOf(payout), 9_000e6);
            assertEq(ousd.balanceOf(refund), 1_000e6);
            assertEq(ousd.balanceOf(address(inv)), 0);
        } else {
            console.log("OUSD: holder has no balance, only creation was checked");
        }
    }

    function test_Fork_OtherSandboxTokensAccepted() public {
        address[3] memory toks = [StdTokens.PATH_USD_ADDRESS, StdTokens.BETA_USD_ADDRESS, StdTokens.THETA_USD_ADDRESS];
        for (uint256 i = 0; i < 3; i++) {
            InvoiceEscrow inv = _create(toks[i], _tiers(), address(0));
            assertEq(inv.getInvoice().token, toks[i]);
        }
    }

    // ───────────────────────── gas ─────────────────────────

    function _tiersN(uint256 n) internal view returns (DiscountTier[] memory t) {
        t = new DiscountTier[](n);
        for (uint256 i = 0; i < n; i++) {
            t[i] = DiscountTier(t0 + uint64((i + 1) * 1 days), uint16(100 * (n - i)));
        }
    }

    function _gasCreate(string memory label, uint256 n) internal {
        DiscountTier[] memory tiers = _tiersN(n);
        vm.prank(seller);
        uint256 g0 = gasleft();
        factory.createInvoice(REF, ALPHA_USD, PRINCIPAL, due, tiers, payout);
        uint256 used = g0 - gasleft();
        vm.snapshotGasLastCall("InvoiceFork", label);
        console.log(label, used);
    }

    function test_Fork_Gas_CreateInvoice_ZeroTiers() public {
        _gasCreate("createInvoice_0_tiers", 0);
    }

    function test_Fork_Gas_CreateInvoice_ThreeTiers() public {
        _gasCreate("createInvoice_3_tiers", 3);
    }

    function test_Fork_Gas_CreateInvoice_TenTiers() public {
        _gasCreate("createInvoice_10_tiers", 10);
    }
}
