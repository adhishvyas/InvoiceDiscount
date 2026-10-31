// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A token that signals failure by returning `false` instead of reverting. While `failing` is true,
///         `transfer` and `transferFrom` move nothing and return `false`. While it is false the token behaves
///         like a plain ERC-20, so a test can fund an invoice and then switch the failure on.
contract FalseReturnToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    bool public failing = true;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function setFailing(bool f) external {
        failing = f;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failing) return false;
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failing) return false;
        uint256 a = allowance[from][msg.sender];
        if (a < amount || balanceOf[from] < amount) return false;
        allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        if (balanceOf[from] < amount) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
