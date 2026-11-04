// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice OpenZeppelin ERC-20 with a public `mint`, plus two switches that model the issuer controls of spec
///         section 3.9: a global pause and a per-address blocklist. Both revert with a custom error so tests can
///         pin the exact selector that bubbles up through `SafeERC20`.
abstract contract MockToken is ERC20 {
    error TokenPaused();
    error Blocked(address account);

    uint8 private immutable _decimals;
    bool public paused;
    mapping(address => bool) public blocked;

    constructor(uint8 decimals_) ERC20("Mock", "MOCK") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (paused) revert TokenPaused();
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/// @notice 6-decimal mock, like PYUSD and USDC.
contract MockERC20 is MockToken(6) {}

/// @notice 18-decimal variant, for amount tests.
contract MockERC20D18 is MockToken(18) {}
