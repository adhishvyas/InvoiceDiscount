// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Sends ETH with Solidity's `transfer` / `send` (2_300-gas stipend).
contract StipendSender {
    function viaTransfer(address payable to) external payable {
        to.transfer(msg.value);
    }

    function viaSend(address payable to) external payable returns (bool) {
        return to.send(msg.value);
    }
}

/// @notice Forces its ETH into `target` with `selfdestruct`, which bypasses `receive()`.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
