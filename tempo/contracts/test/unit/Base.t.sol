// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {ITIP20RolesAuth} from "tempo-std/interfaces/ITIP20RolesAuth.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {StdTokens} from "tempo-std/StdTokens.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";

/// @notice Shared harness: factory, a real local TIP-20, named actors and helpers.
abstract contract Base is Test {
    // Mirror of the real TIP-20 events, so vm.expectEmit can match them.
    event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo);
    event Transfer(address indexed from, address indexed to, uint256 amount);

    // Mirrors of the escrow/factory events.
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
    event SettledDirect(address indexed caller, address payoutAddress, uint256 amount, uint16 discountBps);
    event InvoiceCreated(
        address indexed invoice,
        address indexed seller,
        bytes32 indexed invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate
    );

    // Default invoice (spec 3.8).
    uint128 internal constant PRINCIPAL = 100_000e6;
    uint256 internal constant DAY = 1 days;
    uint64 internal constant T0 = 1_800_000_000; // fixed "invoice date"
    bytes32 internal constant REF = bytes32("INV-2026-0042");

    InvoiceFactory internal factory;
    ITIP20 internal token;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal payout = makeAddr("payout");
    address internal refund = makeAddr("refund");
    address internal stranger = makeAddr("stranger");

    /// @dev An address without the TIP-20 prefix and without code.
    address internal constant UNPREFIXED = address(0xBEEF);
    /// @dev A TIP-20-prefixed address that no token was ever created at (no code).
    address internal constant PREFIXED_NO_CODE = 0x20C0000000000000000000000000000000FffFFf;

    function setUp() public virtual {
        vm.warp(T0);
        factory = new InvoiceFactory();
        token = _newToken("T", bytes32(uint256(1)));
        _mint(token, seller, 1_000_000e6);
        _mint(token, buyer, 1_000_000e6);
        _mint(token, stranger, 1_000_000e6);
    }

    // ───────────── token helpers ─────────────

    function _newToken(string memory sym, bytes32 salt) internal returns (ITIP20 t) {
        address a = StdPrecompiles.TIP20_FACTORY.createToken(sym, sym, "USD", StdTokens.PATH_USD, address(this), salt);
        t = ITIP20(a);
        ITIP20RolesAuth(a).grantRole(t.ISSUER_ROLE(), address(this));
    }

    function _mint(ITIP20 t, address to, uint256 amount) internal {
        t.mint(to, amount);
    }

    function _bal(address who) internal view returns (uint256) {
        return token.balanceOf(who);
    }

    // ───────────── invoice helpers ─────────────

    function _dueDate() internal pure returns (uint64) {
        return T0 + uint64(60 * DAY);
    }

    /// @dev Spec 3.8 tiers: 15% before day 15, 10% before day 30.
    function _defaultTiers() internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](2);
        t[0] = DiscountTier({cutoff: T0 + uint64(15 * DAY), discountBps: 1500});
        t[1] = DiscountTier({cutoff: T0 + uint64(30 * DAY), discountBps: 1000});
    }

    function _noTiers() internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](0);
    }

    /// @dev Create an invoice, pranking as `who`, with full control over parameters.
    function _create(
        address who,
        bytes32 ref,
        address tok,
        uint128 principal,
        uint64 dueDate,
        DiscountTier[] memory tiers,
        address payoutAddress
    ) internal returns (InvoiceEscrow) {
        vm.prank(who);
        return InvoiceEscrow(factory.createInvoice(ref, tok, principal, dueDate, tiers, payoutAddress));
    }

    /// @dev Spec 3.8 invoice: default payout (the seller).
    function _createDefault() internal returns (InvoiceEscrow) {
        return _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), address(0));
    }

    /// @dev Spec 3.8 invoice with the custom payout address.
    function _createWithPayout() internal returns (InvoiceEscrow) {
        return _create(seller, REF, address(token), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
    }

    /// @dev Approve the invoice's principal and fund as `who` with a refund address.
    function _fundAs(InvoiceEscrow inv, address who, address refundAddress) internal {
        uint128 p = inv.getInvoice().principal;
        vm.startPrank(who);
        token.approve(address(inv), p);
        inv.fund(refundAddress);
        vm.stopPrank();
    }

    /// @dev Fund as `buyer`.
    function _fund(InvoiceEscrow inv, address refundAddress) internal {
        _fundAs(inv, buyer, refundAddress);
    }

    /// @dev Warp to `days_` days after T0.
    function _warpDay(uint256 days_) internal {
        vm.warp(T0 + days_ * DAY);
    }

    /// @dev n tiers with cutoffs T0+1d..T0+nd and descending bps.
    function _tiers(uint256 n) internal pure returns (DiscountTier[] memory t) {
        t = new DiscountTier[](n);
        for (uint256 i = 0; i < n; i++) {
            t[i] = DiscountTier({cutoff: T0 + uint64((i + 1) * DAY), discountBps: uint16(100 * (n - i))});
        }
    }

    // ───────────── balance snapshots ─────────────

    struct Bals {
        uint256 seller;
        uint256 buyer;
        uint256 payout;
        uint256 refund;
        uint256 stranger;
        uint256 escrow;
    }

    function _snap(address escrow) internal view returns (Bals memory b) {
        b = Bals(_bal(seller), _bal(buyer), _bal(payout), _bal(refund), _bal(stranger), _bal(escrow));
    }

    function _total(Bals memory b) internal pure returns (uint256) {
        return b.seller + b.buyer + b.payout + b.refund + b.stranger + b.escrow;
    }

    // ───────────── log helpers ─────────────

    struct MemoLog {
        address from;
        address to;
        uint256 amount;
        bytes32 memo;
    }

    /// @dev All `TransferWithMemo` logs emitted by the test token, in order.
    function _memoLogs(Vm.Log[] memory logs) internal view returns (MemoLog[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(token) && logs[i].topics[0] == TransferWithMemo.selector) n++;
        }
        out = new MemoLog[](n);
        uint256 j;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(token) && logs[i].topics[0] == TransferWithMemo.selector) {
                out[j++] = MemoLog(
                    address(uint160(uint256(logs[i].topics[1]))),
                    address(uint160(uint256(logs[i].topics[2]))),
                    abi.decode(logs[i].data, (uint256)),
                    logs[i].topics[3]
                );
            }
        }
    }

    /// @dev Number of logs emitted by `emitter`.
    function _countFrom(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter) n++;
        }
    }

    // ───────────── token pause ─────────────

    function _pauseToken() internal {
        ITIP20RolesAuth(address(token)).grantRole(token.PAUSE_ROLE(), address(this));
        ITIP20RolesAuth(address(token)).grantRole(token.UNPAUSE_ROLE(), address(this));
        token.pause();
    }
}

/// @notice Harness self-test: the only test that is allowed to pass against the stubs.
contract BaseSelfTest is Base {
    function test_Harness_MintApproveAndMemoTransfer() public {
        assertEq(_bal(seller), 1_000_000e6);
        assertEq(token.decimals(), 6);
        assertTrue(StdPrecompiles.TIP20_FACTORY.isTIP20(address(token)));
        assertFalse(StdPrecompiles.TIP20_FACTORY.isTIP20(UNPREFIXED));
        assertFalse(StdPrecompiles.TIP20_FACTORY.isTIP20(PREFIXED_NO_CODE));
        assertEq(PREFIXED_NO_CODE.code.length, 0);

        vm.prank(buyer);
        token.approve(address(this), 10e6);
        assertEq(token.allowance(buyer, address(this)), 10e6);

        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(seller, payout, 5e6, REF);
        vm.prank(seller);
        token.transferWithMemo(payout, 5e6, REF);
        assertEq(_bal(payout), 5e6);

        vm.expectEmit(true, true, true, true, address(token));
        emit TransferWithMemo(buyer, refund, 3e6, REF);
        token.transferFromWithMemo(buyer, refund, 3e6, REF);
        assertEq(_bal(refund), 3e6);
    }
}
