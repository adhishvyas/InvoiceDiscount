// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Actor} from "./Actor.sol";

/// @notice Burns every unit of gas it is given on incoming ETH while `burning` is true (the default).
contract GasBurner is Actor {
    bool public burning = true;

    function setBurning(bool b) external {
        burning = b;
    }

    receive() external payable {
        if (burning) {
            assembly {
                invalid()
            }
        }
    }
}
