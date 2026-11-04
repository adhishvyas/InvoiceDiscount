// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";
import {MockToken, MockERC20, MockERC20D18} from "../mocks/MockERC20.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {FalseReturnToken} from "../mocks/FalseReturnToken.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";

/// @notice Shared harness: factory, a 6-decimal mock ERC-20, named actors and helpers.
abstract contract Base is Test {
    // ERC-20 event, mirrored so vm.expectEmit can match it.
    event Transfer(address indexed from, address indexed to, uint256 value);

    // Mirrors of the escrow/factory events (Ethereum spec 3.6: every escrow event carries `invoiceRef`).
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

    // Native-ETH events (ETH spec 3.9).
    event Received(address indexed from, bytes32 indexed invoiceRef, uint256 amount);
    event PayoutDeferred(address indexed to, bytes32 indexed invoiceRef, uint256 amount);
    event Withdrawn(address indexed account, address to, uint256 amount);

    // Default invoice (spec 3.8).
    uint128 internal constant PRINCIPAL = 100_000e6;
    uint256 internal constant DAY = 1 days;
    uint64 internal constant T0 = 1_800_000_000; // fixed "invoice date"
    bytes32 internal constant REF = bytes32("INV-2026-0042");
    /// @dev Default ETH invoice principal (ETH spec 3): 10 ETH. With the default tiers 15% is 1.5 ETH, 10% is 1 ETH.
    uint128 internal constant ETH_PRINCIPAL = 10 ether;
    address internal constant NATIVE = address(0);

    InvoiceFactory internal factory;
    MockERC20 internal token;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal payout = makeAddr("payout");
    address internal refund = makeAddr("refund");
    address internal stranger = makeAddr("stranger");

    /// @dev An address without code.
    address internal constant NO_CODE = address(0xBEEF);

    function setUp() public virtual {
        vm.warp(T0);
        factory = new InvoiceFactory();
        token = new MockERC20();
        token.mint(seller, 1_000_000e6);
        token.mint(buyer, 1_000_000e6);
        token.mint(stranger, 1_000_000e6);
        vm.deal(seller, 1_000 ether);
        vm.deal(buyer, 1_000 ether);
        vm.deal(stranger, 1_000 ether);
    }

    // ───────────── token helpers ─────────────

    function _newToken() internal returns (MockERC20) {
        return new MockERC20();
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
        return InvoiceEscrow(payable(factory.createInvoice(ref, tok, principal, dueDate, tiers, payoutAddress)));
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

    // ───────────── ETH invoice helpers ─────────────

    /// @dev ETH invoice with the default tiers and due date; `payoutAddress == 0` means the seller.
    function _createEthWith(address payoutAddress, DiscountTier[] memory tiers) internal returns (InvoiceEscrow) {
        return _create(seller, REF, NATIVE, ETH_PRINCIPAL, _dueDate(), tiers, payoutAddress);
    }

    function _createEth() internal returns (InvoiceEscrow) {
        return _createEthWith(address(0), _defaultTiers());
    }

    /// @dev ETH invoice with the custom payout address.
    function _createEthWithPayout() internal returns (InvoiceEscrow) {
        return _createEthWith(payout, _defaultTiers());
    }

    /// @dev Fund an ETH invoice as `who` with exactly its principal.
    function _fundEthAs(InvoiceEscrow inv, address who, address refundAddress) internal {
        uint128 p = inv.getInvoice().principal;
        vm.prank(who);
        inv.fund{value: p}(refundAddress);
    }

    function _fundEth(InvoiceEscrow inv, address refundAddress) internal {
        _fundEthAs(inv, buyer, refundAddress);
    }

    /// @dev A plain ETH transfer (empty calldata) from `from`; returns the raw outcome.
    function _sendEth(address from, address to, uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = to.call{value: amount}("");
    }

    function _sel(bytes memory ret) internal pure returns (bytes4) {
        return ret.length >= 4 ? bytes4(ret) : bytes4(0);
    }

    /// @dev Expect the escrow's `Paid` event.
    function _expectPaid(
        InvoiceEscrow inv,
        address caller,
        address payoutAddr,
        uint128 toSeller,
        address refundAddr,
        uint128 refundAmt,
        uint16 bps
    ) internal {
        vm.expectEmit(true, true, false, true, address(inv));
        emit Paid(caller, REF, payoutAddr, toSeller, refundAddr, refundAmt, bps);
    }

    function _expectDeferred(InvoiceEscrow inv, address to, uint256 amount) internal {
        vm.expectEmit(true, true, false, true, address(inv));
        emit PayoutDeferred(to, REF, amount);
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

    // ───────────── event expectations ─────────────

    /// @dev Expect the ERC-20 `Transfer(from, to, amount)` log from `tok`.
    function _expectTransfer(address tok, address from, address to, uint256 amount) internal {
        vm.expectEmit(true, true, false, true, tok);
        emit Transfer(from, to, amount);
    }

    /// @dev Expect the ERC-20 `Transfer(from, to, amount)` log from the default `token`.
    function _expectTransfer(address from, address to, uint256 amount) internal {
        _expectTransfer(address(token), from, to, amount);
    }

    // ───────────── log helpers ─────────────

    struct XferLog {
        address from;
        address to;
        uint256 amount;
    }

    /// @dev All ERC-20 `Transfer` logs emitted by the default `token`, in order.
    function _xferLogs(Vm.Log[] memory logs) internal view returns (XferLog[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(token) && logs[i].topics[0] == Transfer.selector) n++;
        }
        out = new XferLog[](n);
        uint256 j;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(token) && logs[i].topics[0] == Transfer.selector) {
                out[j++] = XferLog(
                    address(uint160(uint256(logs[i].topics[1]))),
                    address(uint160(uint256(logs[i].topics[2]))),
                    abi.decode(logs[i].data, (uint256))
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
}

/// @notice Harness self-test: the only tests allowed to pass against the stubs. They exercise the mocks and
///         never touch the escrow or the factory's `createInvoice`.
contract BaseSelfTest is Base {
    function test_Harness_MockERC20_MintApproveTransfer() public {
        assertEq(token.decimals(), 6);
        assertEq(_bal(seller), 1_000_000e6);

        vm.prank(buyer);
        token.approve(address(this), 10e6);
        assertEq(token.allowance(buyer, address(this)), 10e6);

        _expectTransfer(seller, payout, 5e6);
        vm.prank(seller);
        token.transfer(payout, 5e6);
        assertEq(_bal(payout), 5e6);

        _expectTransfer(buyer, refund, 3e6);
        token.transferFrom(buyer, refund, 3e6);
        assertEq(_bal(refund), 3e6);
        assertEq(token.allowance(buyer, address(this)), 7e6);
    }

    function test_Harness_MockERC20_PauseAndBlocklist() public {
        token.setPaused(true);
        vm.expectRevert(MockToken.TokenPaused.selector);
        vm.prank(seller);
        token.transfer(payout, 1);
        token.setPaused(false);

        token.setBlocked(payout, true);
        vm.expectRevert(abi.encodeWithSelector(MockToken.Blocked.selector, payout));
        vm.prank(seller);
        token.transfer(payout, 1);
        token.setBlocked(payout, false);
        vm.prank(seller);
        token.transfer(payout, 1);
        assertEq(_bal(payout), 1);
    }

    function test_Harness_MockERC20D18() public {
        MockERC20D18 t = new MockERC20D18();
        assertEq(t.decimals(), 18);
        t.mint(seller, 5e18);
        vm.prank(seller);
        t.transfer(payout, 2e18);
        assertEq(t.balanceOf(payout), 2e18);
        assertEq(t.balanceOf(seller), 3e18);
    }

    function test_Harness_NoReturnToken() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(seller, 10e6);
        // raw calls: nothing is returned
        vm.prank(seller);
        (bool ok, bytes memory ret) = address(t).call(abi.encodeCall(NoReturnToken.transfer, (payout, 4e6)));
        assertTrue(ok);
        assertEq(ret.length, 0, "no return data");
        vm.prank(seller);
        (ok, ret) = address(t).call(abi.encodeCall(NoReturnToken.approve, (address(this), 6e6)));
        assertTrue(ok);
        assertEq(ret.length, 0);
        (ok, ret) = address(t).call(abi.encodeCall(NoReturnToken.transferFrom, (seller, refund, 6e6)));
        assertTrue(ok);
        assertEq(ret.length, 0);
        assertEq(t.balanceOf(payout), 4e6);
        assertEq(t.balanceOf(refund), 6e6);
        assertEq(t.balanceOf(seller), 0);
    }

    function test_Harness_FalseReturnToken() public {
        FalseReturnToken t = new FalseReturnToken();
        t.mint(seller, 10e6);
        assertTrue(t.failing());
        vm.prank(seller);
        assertFalse(t.transfer(payout, 4e6));
        assertEq(t.balanceOf(seller), 10e6, "nothing moved");
        t.setFailing(false);
        vm.prank(seller);
        assertTrue(t.transfer(payout, 4e6));
        assertEq(t.balanceOf(payout), 4e6);
    }

    function test_Harness_ReentrantToken_FiresOnceOnTransferNotOnMint() public {
        ReentrantToken t = new ReentrantToken();
        // a target that records that it was called
        address probe = address(new Probe());
        t.arm(probe, abi.encodeCall(Probe.ping, ()));
        t.mint(seller, 10e6);
        assertFalse(t.fired(), "mint does not fire the callback");

        vm.prank(seller);
        t.transfer(payout, 1e6);
        assertTrue(t.fired());
        assertTrue(t.innerSuccess());
        assertEq(Probe(probe).pings(), 1);
        assertEq(t.balanceOf(payout), 1e6);

        vm.prank(seller);
        t.transfer(payout, 1e6);
        assertEq(Probe(probe).pings(), 1, "one-shot");

        // exec makes the call from the token's own address
        assertEq(abi.decode(t.exec(probe, abi.encodeCall(Probe.who, ())), (address)), address(t));
    }
}


contract Probe {
    uint256 public pings;

    function ping() external {
        pings++;
    }

    function who() external view returns (address) {
        return msg.sender;
    }
}
