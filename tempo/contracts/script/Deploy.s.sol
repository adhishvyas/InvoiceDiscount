// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceFactory} from "../src/InvoiceFactory.sol";

/// @notice Deploys the factory, which deploys the escrow implementation in its constructor.
/// The deploy block is in the broadcast receipt: `cast receipt <tx> blockNumber --rpc-url $TEMPO_RPC_URL`.
contract Deploy is Script {
    function run() external returns (InvoiceFactory factory) {
        vm.startBroadcast();
        factory = new InvoiceFactory();
        vm.stopBroadcast();

        console.log("InvoiceFactory:", address(factory));
        console.log("Implementation:", factory.implementation());
    }
}
