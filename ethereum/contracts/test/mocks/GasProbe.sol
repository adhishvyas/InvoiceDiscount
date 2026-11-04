// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Actor} from "./Actor.sol";

/// @notice Receiver that needs `need` gas on entry: it reverts when `gasleft()` at the start of `receive` is below
///         `need`. It records the gas it was given (`gasSeen`) and how it was called, so a test can show the
///         gas cap of a push (about 50_000 plus the 2_300 call stipend) and the uncapped gas of `withdraw`.
contract GasProbe is Actor {
    uint256 public need;
    uint256 public gasSeen = 1; // non-zero so the later write is cheap
    uint256 public receiveCalls;
    uint256 public fallbackCalls;
    uint256 public lastFallbackLen;

    constructor(uint256 need_) {
        need = need_;
    }

    function setNeed(uint256 n) external {
        need = n;
    }

    receive() external payable {
        uint256 g = gasleft();
        if (g < need) revert("GasProbe: not enough gas");
        gasSeen = g;
        receiveCalls++;
    }

    /// @dev Reached only when the caller sends non-empty calldata.
    fallback() external payable {
        fallbackCalls++;
        lastFallbackLen = msg.data.length;
    }
}
