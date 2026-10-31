// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 that calls back into a target during a transfer, like an ERC-777 hook. The callback runs after
///         the balances have moved, with `msg.sender == address(this)` (the token). To make that caller a party
///         of an invoice, the token can act as a wallet: `exec` sends an arbitrary call from the token's own
///         address, so a test can make the token the seller (via the factory) or the buyer (via `fund`).
///
///         `arm(target, data)` schedules ONE callback, fired by the next real transfer (transfer or
///         transferFrom, not mint). The result of the inner call is recorded, not bubbled, so the outer call
///         completes and the test can inspect what the inner call did.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public data;
    bool public armed;
    bool public fired;
    bool public innerSuccess;
    bytes public innerReturn;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
        fired = false;
        innerSuccess = false;
        delete innerReturn;
    }

    /// @notice The token has no key, so it approves `spender` through this function.
    function approveSelf(address spender, uint256 amount) external {
        _approve(address(this), spender, amount);
    }

    /// @notice Make a call from the token's own address; reverts with the callee's revert data on failure.
    function exec(address to, bytes calldata payload) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false;
            fired = true;
            (innerSuccess, innerReturn) = target.call(data);
        }
    }
}
