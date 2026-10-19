// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {InvoiceEscrow, DiscountTier} from "./InvoiceEscrow.sol";

/// @title InvoiceFactory
/// @notice Deploys and initialises one EIP-1167 clone of `InvoiceEscrow` per invoice.
/// @dev INTERFACE FREEZE (tag `tempo-interface-v1`): signatures, events and NatSpec behaviour are final.
///      Bodies are stubs.
contract InvoiceFactory {
    /// @notice The `InvoiceEscrow` implementation that every invoice clones.
    address public immutable implementation;

    /// @notice Emitted by `createInvoice` after the clone is initialised.
    /// @dev `invoice`, `seller` and `invoiceRef` are indexed, so an invoice can be found from its reference.
    event InvoiceCreated(
        address indexed invoice,
        address indexed seller,
        bytes32 indexed invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate
    );

    /// @notice Deploys the implementation: `implementation = address(new InvoiceEscrow())`.
    /// @dev The escrow constructor sets its `factory` to this contract. Takes no arguments.
    constructor() {
        implementation = address(new InvoiceEscrow());
    }

    /// @notice Create an invoice. The caller becomes the seller.
    /// @dev Steps: `invoice = Clones.clone(implementation)`; then
    ///      `InvoiceEscrow(invoice).initialize(msg.sender, invoiceRef, token, principal, dueDate, tiers, payoutAddress)`;
    ///      then emit `InvoiceCreated(invoice, msg.sender, invoiceRef, token, principal, dueDate)`; return `invoice`.
    ///      Every validation of `InvoiceEscrow.initialize` applies and its error bubbles up unchanged
    ///      (`EmptyInvoiceRef`, `InvalidPrincipal`, `DueDateNotInFuture`, `TooManyTiers`, `TiersNotAscending`,
    ///      `TierAfterDueDate`, `DiscountTooLarge`, `NotTIP20`); the whole transaction reverts, so no clone
    ///      remains. The factory does not enforce unique references.
    /// @param invoiceRef 32-byte UTF-8 reference, must be non-zero.
    /// @param token A TIP-20 token.
    /// @param principal Amount in token base units; must be non-zero.
    /// @param dueDate Unix timestamp in the future.
    /// @param tiers Up to 10 discount tiers with strictly ascending cutoffs, none after `dueDate`.
    /// @param payoutAddress Where the seller is paid; address(0) means the seller.
    /// @return invoice The address of the new invoice (the clone).
    function createInvoice(
        bytes32 invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate,
        DiscountTier[] calldata tiers,
        address payoutAddress
    ) external returns (address invoice) {
        invoice = Clones.clone(implementation);
        InvoiceEscrow(invoice).initialize(msg.sender, invoiceRef, token, principal, dueDate, tiers, payoutAddress);
        emit InvoiceCreated(invoice, msg.sender, invoiceRef, token, principal, dueDate);
    }
}
