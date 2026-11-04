// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base} from "./Base.t.sol";
import {InvoiceEscrow, DiscountTier, InvoiceState, Status} from "../../src/InvoiceEscrow.sol";
import {InvoiceFactory} from "../../src/InvoiceFactory.sol";
import {MockERC20D18} from "../mocks/MockERC20.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {FalseReturnToken} from "../mocks/FalseReturnToken.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";

/// @notice ERC-20 specifics (Ethereum spec section 6): tokens that return nothing or `false`, a token that calls
///         back into the escrow, other decimals, and stray transfers.
contract InvoiceEscrowTokensTest is Base {
    // ═════════════════════════ NoReturnToken (USDT style) ═════════════════════════

    function test_NoReturnValueToken() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(buyer, 1_000_000e6);

        // fund
        InvoiceEscrow a = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        vm.startPrank(buyer);
        t.approve(address(a), PRINCIPAL);
        _expectTransfer(address(t), buyer, address(a), PRINCIPAL);
        vm.expectEmit(true, true, false, true, address(a));
        emit Funded(buyer, REF, refund, PRINCIPAL);
        a.fund(refund);
        vm.stopPrank();
        assertEq(t.balanceOf(address(a)), PRINCIPAL);
        assertEq(uint8(a.getInvoice().status), uint8(Status.Funded));

        // pay with a discount
        _warpDay(5);
        _expectTransfer(address(t), address(a), payout, 85_000e6);
        _expectTransfer(address(t), address(a), refund, 15_000e6);
        vm.expectEmit(true, true, false, true, address(a));
        emit Paid(seller, REF, payout, 85_000e6, refund, 15_000e6, 1500);
        vm.prank(seller);
        a.triggerPayment();
        assertEq(t.balanceOf(payout), 85_000e6);
        assertEq(t.balanceOf(refund), 15_000e6);
        assertEq(t.balanceOf(address(a)), 0);
        assertEq(uint8(a.getInvoice().status), uint8(Status.Paid));

        // cancel a funded invoice
        vm.warp(T0);
        InvoiceEscrow b = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        vm.startPrank(buyer);
        t.approve(address(b), PRINCIPAL);
        b.fund(refund);
        vm.stopPrank();
        _expectTransfer(address(t), address(b), refund, PRINCIPAL);
        vm.expectEmit(true, true, false, true, address(b));
        emit Cancelled(seller, REF, PRINCIPAL);
        vm.prank(seller);
        b.cancel();
        assertEq(t.balanceOf(refund), 15_000e6 + PRINCIPAL);
        assertEq(t.balanceOf(address(b)), 0);
        assertEq(uint8(b.getInvoice().status), uint8(Status.Cancelled));

        // settleDirect (reads balanceOf, forwards through safeTransfer)
        InvoiceEscrow c = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        vm.prank(buyer);
        t.transfer(address(c), 85_000e6);
        _expectTransfer(address(t), address(c), payout, 85_000e6);
        vm.expectEmit(true, true, false, true, address(c));
        emit SettledDirect(stranger, REF, payout, 85_000e6, 1500);
        vm.prank(stranger);
        c.settleDirect();
        assertEq(t.balanceOf(payout), 170_000e6);
        assertEq(t.balanceOf(address(c)), 0);
    }

    function test_NoReturnValueToken_RevertingTokenBubblesItsError() public {
        // a no-return token still reverts on a missing allowance; SafeERC20 bubbles that data up unchanged
        NoReturnToken t = new NoReturnToken();
        t.mint(buyer, PRINCIPAL);
        InvoiceEscrow a = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        vm.expectRevert(NoReturnToken.InsufficientAllowance.selector);
        vm.prank(buyer);
        a.fund(refund);
        assertEq(uint8(a.getInvoice().status), uint8(Status.Active));
        assertEq(a.getInvoice().buyer, address(0));
    }

    // ═════════════════════════ FalseReturnToken ═════════════════════════

    function _falseErr(FalseReturnToken t) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t));
    }

    function test_FalseReturnValueToken() public {
        FalseReturnToken t = new FalseReturnToken();
        t.mint(buyer, 1_000_000e6);
        InvoiceEscrow a = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);

        // fund: the pull returns false -> SafeERC20FailedOperation, nothing changes
        vm.startPrank(buyer);
        t.approve(address(a), PRINCIPAL);
        vm.expectRevert(_falseErr(t));
        a.fund(refund);
        vm.stopPrank();
        InvoiceState memory s = a.getInvoice();
        assertEq(uint8(s.status), uint8(Status.Active), "status unchanged");
        assertEq(s.buyer, address(0), "buyer unchanged");
        assertEq(s.refundAddress, address(0), "refund address unchanged");
        assertEq(t.balanceOf(address(a)), 0);
        assertEq(t.balanceOf(buyer), 1_000_000e6);

        // the same invoice funds fine once the token behaves
        t.setFailing(false);
        vm.prank(buyer);
        a.fund(refund);
        assertEq(uint8(a.getInvoice().status), uint8(Status.Funded));
        assertEq(t.balanceOf(address(a)), PRINCIPAL);

        // payout and cancel: the push returns false -> revert, still Funded, funds still in escrow
        t.setFailing(true);
        _warpDay(5);
        vm.expectRevert(_falseErr(t));
        vm.prank(seller);
        a.triggerPayment();
        vm.expectRevert(_falseErr(t));
        vm.prank(seller);
        a.cancel();
        assertEq(uint8(a.getInvoice().status), uint8(Status.Funded), "status rolled back");
        assertEq(t.balanceOf(address(a)), PRINCIPAL);
        assertEq(t.balanceOf(payout), 0);
        assertEq(t.balanceOf(refund), 0);

        t.setFailing(false);
        vm.prank(seller);
        a.triggerPayment();
        assertEq(uint8(a.getInvoice().status), uint8(Status.Paid));
        assertEq(t.balanceOf(payout), 85_000e6);
        assertEq(t.balanceOf(refund), 15_000e6);
    }

    function test_FalseReturnValueToken_SettleDirect() public {
        FalseReturnToken t = new FalseReturnToken();
        t.mint(buyer, PRINCIPAL);
        InvoiceEscrow a = _create(seller, REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout);
        t.setFailing(false);
        vm.prank(buyer);
        t.transfer(address(a), 85_000e6);
        t.setFailing(true);
        vm.expectRevert(_falseErr(t));
        vm.prank(stranger);
        a.settleDirect();
        assertEq(uint8(a.getInvoice().status), uint8(Status.Active));
        assertEq(t.balanceOf(address(a)), 85_000e6);

        t.setFailing(false);
        vm.prank(stranger);
        a.settleDirect();
        assertEq(t.balanceOf(payout), 85_000e6);
        assertEq(uint8(a.getInvoice().status), uint8(Status.Paid));
    }

    // ═════════════════════════ ReentrantToken ═════════════════════════

    uint256 internal constant FUND_AMOUNT = 100_000e6;

    /// @dev Make `t` the seller of a fresh invoice priced in `t`, with the spec 3.8 tiers.
    function _invoiceSoldBy(ReentrantToken t, address payoutAddress) internal returns (InvoiceEscrow) {
        bytes memory ret = t.exec(
            address(factory),
            abi.encodeWithSelector(
                InvoiceFactory.createInvoice.selector,
                REF,
                address(t),
                PRINCIPAL,
                _dueDate(),
                _defaultTiers(),
                payoutAddress
            )
        );
        return InvoiceEscrow(payable(abi.decode(ret, (address))));
    }

    function _fundWith(ReentrantToken t, InvoiceEscrow inv, address who) internal {
        t.mint(who, FUND_AMOUNT);
        vm.startPrank(who);
        t.approve(address(inv), FUND_AMOUNT);
        inv.fund(refund);
        vm.stopPrank();
    }

    function _arm(ReentrantToken t, InvoiceEscrow inv, bytes memory call_) internal {
        t.arm(address(inv), call_);
    }

    /// @dev The callback fired, and the re-entered call reverted with exactly `selector`.
    function _assertReentryReverted(ReentrantToken t, bytes4 selector) internal view {
        assertTrue(t.fired(), "the callback ran during the transfer");
        assertFalse(t.innerSuccess(), "the re-entered call must revert");
        bytes memory r = t.innerReturn();
        assertEq(r.length, 4, "a bare custom error");
        assertEq(bytes4(r), selector, "status error of the re-entered function");
    }

    function _payload(uint256 which) internal pure returns (bytes memory) {
        if (which == 0) return abi.encodeCall(InvoiceEscrow.triggerPayment, ());
        if (which == 1) return abi.encodeCall(InvoiceEscrow.cancel, ());
        if (which == 2) return abi.encodeCall(InvoiceEscrow.settleDirect, ());
        return abi.encodeCall(InvoiceEscrow.fund, (address(0)));
    }

    function test_ReentrantTokenCannotDoubleSpend() public {
        // The token is the seller (so it is a party) and calls back from its own address while the escrow is
        // paying out. Every re-entered function reverts with its status error, because the status was
        // written before the transfer.
        bytes4[4] memory expectedAfterPaid = [
            InvoiceEscrow.NotFunded.selector, // triggerPayment
            InvoiceEscrow.AlreadySettled.selector, // cancel (seller is authorised, status is Paid)
            InvoiceEscrow.NotActive.selector, // settleDirect
            InvoiceEscrow.NotActive.selector // fund
        ];
        for (uint256 which = 0; which < 4; which++) {
            vm.warp(T0);
            ReentrantToken t = new ReentrantToken();
            InvoiceEscrow inv = _invoiceSoldBy(t, payout);
            _fundWith(t, inv, buyer);
            _warpDay(5);

            _arm(t, inv, _payload(which));
            vm.prank(buyer);
            inv.triggerPayment();

            _assertReentryReverted(t, expectedAfterPaid[which]);
            // paid exactly once
            assertEq(t.balanceOf(payout), 85_000e6, "payout paid once");
            assertEq(t.balanceOf(refund), 15_000e6, "refund paid once");
            assertEq(t.balanceOf(address(inv)), 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        }
    }

    function test_ReentrantTokenCannotDoubleSpend_DuringCancel() public {
        bytes4[4] memory expectedAfterCancel = [
            InvoiceEscrow.NotFunded.selector, // triggerPayment
            InvoiceEscrow.AlreadySettled.selector, // cancel
            InvoiceEscrow.NotActive.selector, // settleDirect
            InvoiceEscrow.NotActive.selector // fund
        ];
        for (uint256 which = 0; which < 4; which++) {
            vm.warp(T0);
            ReentrantToken t = new ReentrantToken();
            InvoiceEscrow inv = _invoiceSoldBy(t, payout);
            _fundWith(t, inv, buyer);

            _arm(t, inv, _payload(which));
            vm.warp(_dueDate() + 1); // the buyer may cancel after the due date
            vm.prank(buyer);
            inv.cancel();

            _assertReentryReverted(t, expectedAfterCancel[which]);
            assertEq(t.balanceOf(refund), FUND_AMOUNT, "refunded once");
            assertEq(t.balanceOf(payout), 0);
            assertEq(t.balanceOf(address(inv)), 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Cancelled));
        }
    }

    function test_ReentrantTokenCannotDoubleSpend_DuringSettleDirect() public {
        bytes4[4] memory expectedAfterSettle = [
            InvoiceEscrow.NotFunded.selector, // triggerPayment (seller is a party, status is Paid)
            InvoiceEscrow.AlreadySettled.selector, // cancel
            InvoiceEscrow.NotActive.selector, // settleDirect
            InvoiceEscrow.NotActive.selector // fund
        ];
        for (uint256 which = 0; which < 4; which++) {
            vm.warp(T0);
            ReentrantToken t = new ReentrantToken();
            InvoiceEscrow inv = _invoiceSoldBy(t, payout);
            t.mint(buyer, 85_000e6);
            vm.prank(buyer);
            t.transfer(address(inv), 85_000e6);

            _arm(t, inv, _payload(which));
            vm.prank(stranger);
            inv.settleDirect();

            _assertReentryReverted(t, expectedAfterSettle[which]);
            assertEq(t.balanceOf(payout), 85_000e6, "forwarded once");
            assertEq(t.balanceOf(address(inv)), 0);
            assertEq(uint8(inv.getInvoice().status), uint8(Status.Paid));
        }
    }

    function test_ReentrantTokenCannotDoubleSpend_DuringFund() public {
        // The token is the buyer: it funds the invoice from its own balance, and calls back while the escrow is
        // pulling the principal. The status is already Funded, so a second fund reverts.
        bytes4[3] memory expectedDuringFund = [
            InvoiceEscrow.NotActive.selector, // fund
            InvoiceEscrow.NotActive.selector, // settleDirect
            InvoiceEscrow.NotAuthorizedToCancel.selector // cancel: the token is the buyer, but before the due date
        ];
        bytes[3] memory payloads = [
            abi.encodeCall(InvoiceEscrow.fund, (address(0))),
            abi.encodeCall(InvoiceEscrow.settleDirect, ()),
            abi.encodeCall(InvoiceEscrow.cancel, ())
        ];
        for (uint256 which = 0; which < 3; which++) {
            vm.warp(T0);
            ReentrantToken t = new ReentrantToken();
            vm.prank(seller);
            InvoiceEscrow inv = InvoiceEscrow(payable(
                factory.createInvoice(REF, address(t), PRINCIPAL, _dueDate(), _defaultTiers(), payout)
            ));
            t.mint(address(t), 2 * FUND_AMOUNT);
            t.approveSelf(address(inv), 2 * FUND_AMOUNT);

            _arm(t, inv, payloads[which]);
            t.exec(address(inv), abi.encodeCall(InvoiceEscrow.fund, (refund)));

            _assertReentryReverted(t, expectedDuringFund[which]);
            // funded exactly once
            assertEq(t.balanceOf(address(inv)), PRINCIPAL, "one principal in escrow");
            assertEq(t.balanceOf(address(t)), 2 * FUND_AMOUNT - PRINCIPAL);
            InvoiceState memory s = inv.getInvoice();
            assertEq(uint8(s.status), uint8(Status.Funded));
            assertEq(s.buyer, address(t));
            assertEq(s.refundAddress, refund);
        }
    }

    // ═════════════════════════ other decimals ═════════════════════════

    function test_Decimals18_PaymentSplitAndRounding() public {
        MockERC20D18 t = new MockERC20D18();
        assertEq(t.decimals(), 18);

        // 1_234_567.000000000000000001 tokens: the 15% discount floors at the base-unit level
        uint128 principal = 1_234_567e18 + 1;
        t.mint(buyer, principal);
        InvoiceEscrow inv = _create(seller, REF, address(t), principal, _dueDate(), _defaultTiers(), payout);
        vm.startPrank(buyer);
        t.approve(address(inv), principal);
        inv.fund(refund);
        vm.stopPrank();

        _warpDay(5);
        uint256 expRefund = (uint256(principal) * 1500) / 10_000; // 185_185.05e18 + 0 (floored)
        _expectTransfer(address(t), address(inv), payout, principal - expRefund);
        _expectTransfer(address(t), address(inv), refund, expRefund);
        vm.expectEmit(true, true, false, true, address(inv));
        emit Paid(seller, REF, payout, uint128(principal - expRefund), refund, uint128(expRefund), 1500);
        vm.prank(seller);
        inv.triggerPayment();
        assertEq(t.balanceOf(refund), expRefund);
        assertEq(t.balanceOf(payout), principal - expRefund);
        assertEq(expRefund, 185_185_050000000000000000, "15% of 1_234_567e18 + 1, floored");
        assertEq(t.balanceOf(address(inv)), 0);
    }

    function test_Decimals18_CancelAndSettleDirect() public {
        MockERC20D18 t = new MockERC20D18();
        uint128 principal = 250_000e18;
        t.mint(buyer, principal);
        InvoiceEscrow a = _create(seller, REF, address(t), principal, _dueDate(), _defaultTiers(), payout);
        vm.startPrank(buyer);
        t.approve(address(a), principal);
        a.fund(address(0));
        vm.stopPrank();
        vm.prank(seller);
        a.cancel();
        assertEq(t.balanceOf(buyer), principal, "refunded to the buyer's own address");

        // settleDirect at 10% off: due = 225_000e18; one base unit short reverts
        InvoiceEscrow b = _create(seller, REF, address(t), principal, _dueDate(), _defaultTiers(), payout);
        _warpDay(20);
        uint256 due = 225_000e18;
        vm.prank(buyer);
        t.transfer(address(b), due - 1);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.InsufficientDirectPayment.selector, due - 1, due));
        vm.prank(stranger);
        b.settleDirect();
        vm.prank(buyer);
        t.transfer(address(b), 1);
        vm.prank(stranger);
        b.settleDirect();
        assertEq(t.balanceOf(payout), due);
    }

    // ═════════════════════════ stray transfers ═════════════════════════

    function test_StrayTokensBeforeFunding_StayInEscrowAfterPayment() public {
        // SPEC-QUESTION 3: tokens sent to an Active clone that is then funded normally. Assumed: triggerPayment
        // splits `principal` only, so the stray amount stays in the clone (spec 3.5 amounts; 3.9 "stay there").
        InvoiceEscrow inv = _createWithPayout();
        vm.prank(stranger);
        token.transfer(address(inv), 1_234e6); // sent to an Active clone, then the invoice is funded the normal way
        _fund(inv, refund);
        assertEq(_bal(address(inv)), PRINCIPAL + 1_234e6);

        _warpDay(5);
        vm.prank(seller);
        inv.triggerPayment();
        // only the principal is split; the stray amount is not paid out (spec 3.9)
        assertEq(_bal(payout), 85_000e6);
        assertEq(_bal(refund), 15_000e6);
        assertEq(_bal(address(inv)), 1_234e6, "stray tokens stay in the clone");
    }

    function test_StrayTokensInFundedClone_CancelRefundsOnlyPrincipal() public {
        InvoiceEscrow inv = _createWithPayout();
        _fund(inv, refund);
        vm.prank(stranger);
        token.transfer(address(inv), 500e6);
        vm.prank(seller);
        inv.cancel();
        assertEq(_bal(refund), PRINCIPAL);
        assertEq(_bal(address(inv)), 500e6);
    }
}
