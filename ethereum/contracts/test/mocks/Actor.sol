// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A contract that can act as seller, buyer, payout or refund address: `exec` makes an arbitrary call
///         (with value) from the contract's own address. `exec` bubbles the callee's revert data.
abstract contract Actor {
    function exec(address to, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
