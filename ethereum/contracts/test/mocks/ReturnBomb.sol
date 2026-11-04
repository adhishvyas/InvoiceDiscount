// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Actor} from "./Actor.sol";

/// @notice On incoming ETH it ends the call with a huge payload (`BOMB` bytes): reverting with it
///         (mode 0, the default) or returning it successfully (mode 1). Used to show the escrow neither copies
///         return data nor lets it cost the caller gas. 60_000 bytes still fits under the 50_000 gas cap.
contract ReturnBomb is Actor {
    uint256 public constant BOMB = 60_000;
    uint256 public mode; // 0 = revert with the bomb, 1 = succeed returning the bomb, 2 = accept quietly

    function setMode(uint256 m) external {
        mode = m;
    }

    fallback() external payable {
        uint256 m = mode;
        uint256 n = BOMB;
        assembly {
            if iszero(m) { revert(0, n) }
            if eq(m, 1) { return(0, n) }
            stop()
        }
    }
}
