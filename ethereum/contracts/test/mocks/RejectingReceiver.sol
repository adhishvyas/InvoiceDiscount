// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Actor} from "./Actor.sol";

/// @notice Reverts on any incoming ETH while `accepting` is false (the default); accepts it afterwards.
contract RejectingReceiver is Actor {
    bool public accepting;

    function setAccepting(bool a) external {
        accepting = a;
    }

    receive() external payable {
        if (!accepting) revert("RejectingReceiver");
    }

    fallback() external payable {
        if (!accepting) revert("RejectingReceiver");
    }
}
