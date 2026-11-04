// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Actor} from "./Actor.sol";

/// @notice An ETH recipient that, once armed, calls back into `target` the first time it receives ETH, and records
///         whether that inner call succeeded and the 4-byte selector of its revert data. It can act as seller,
///         buyer, payout or refund address (see `Actor`). While `rejecting` it reverts on incoming ETH instead
///         (to create a credit), and does nothing else.
///
///         The record is a single packed slot so the whole callback fits inside the 50_000-gas push cap.
contract ReentrantReceiver is Actor {
    enum Kind {
        None,
        Trigger, //      triggerPayment()
        Cancel, //       cancel()
        SettleDirect, // settleDirect()
        Fund, //         fund(address(0)) with `value`
        Send, //         plain ETH transfer of `value`
        Withdraw //      withdraw(address(this))
    }

    address public target;
    uint96 public value;

    Kind public kind;
    bool public armed;
    bool public fired;
    bool public ok;
    bytes4 public sel;
    bool public rejecting;

    function setRejecting(bool r) external {
        rejecting = r;
    }

    /// @notice Schedule ONE callback, fired by the next ETH received while not `rejecting`.
    function arm(address target_, Kind kind_, uint96 value_) external {
        target = target_;
        value = value_;
        kind = kind_;
        armed = true;
        fired = false;
        ok = false;
        sel = bytes4(0);
    }

    receive() external payable {
        if (rejecting) revert("ReentrantReceiver: rejecting");
        if (!armed) return;
        armed = false;
        Kind k = kind;
        bytes memory data;
        if (k == Kind.Trigger) data = abi.encodeWithSignature("triggerPayment()");
        else if (k == Kind.Cancel) data = abi.encodeWithSignature("cancel()");
        else if (k == Kind.SettleDirect) data = abi.encodeWithSignature("settleDirect()");
        else if (k == Kind.Fund) data = abi.encodeWithSignature("fund(address)", address(0));
        else if (k == Kind.Withdraw) data = abi.encodeWithSignature("withdraw(address)", address(this));
        (bool s, bytes memory r) = target.call{value: value}(data);
        fired = true;
        ok = s;
        sel = r.length >= 4 ? bytes4(r) : bytes4(0);
    }
}
