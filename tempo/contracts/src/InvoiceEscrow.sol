// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";

/// @notice Lifecycle state of an invoice.
enum Status {
    Active, // created, not yet funded
    Funded, // principal is locked in escrow
    Paid, // settled: split between payout and refund addresses
    Cancelled // terminated: principal (if any) returned to the refund address
}

/// @notice One early-payment discount tier.
struct DiscountTier {
    uint64 cutoff; // unix timestamp (seconds); the tier applies if payment is triggered strictly before this time
    uint16 discountBps; // basis points, 1500 = 15%, at most 10_000
}

/// @notice Full state of an invoice as returned by `getInvoice`.
struct InvoiceState {
    bytes32 invoiceRef; // UTF-8 reference, right-padded with zero bytes
    address seller;
    address payoutAddress; // resolved: the seller if none was given
    address buyer; // address(0) until funded
    address refundAddress; // resolved: the buyer if none was given; address(0) until funded
    address token;
    uint128 principal;
    uint64 dueDate;
    DiscountTier[] tiers; // in the order given at creation
    Status status;
}

/// @title InvoiceEscrow
/// @notice Escrow for one invoice. Deployed once as an implementation; each invoice is an
///         EIP-1167 clone created and initialised atomically by `InvoiceFactory`.
/// @dev INTERFACE FREEZE (tag `tempo-interface-v1`): signatures, events, errors and the behaviour
///      described in the NatSpec below are final. Bodies are stubs.
///
///      Storage layout (clones): slot 0 = seller (20 B) | dueDate (8 B) | status (1 B) | initialized (1 B);
///      1 token; 2 invoiceRef; 3 principal; 4 payoutAddress (zero if none); 5 buyer; 6 refundAddress
///      (zero if none); 7 packed tiers (length, then three tiers per slot). The implementation is free to
///      change this layout, but must not use more fresh slots.
contract InvoiceEscrow {
    // ───────────────────────────── Errors ─────────────────────────────
    error NotFactory();
    error AlreadyInitialized();
    error EmptyInvoiceRef();
    error InvalidPrincipal();
    error DueDateNotInFuture();
    error TooManyTiers();
    error TiersNotAscending();
    error TierAfterDueDate();
    error DiscountTooLarge();
    error NotTIP20();
    error NotActive();
    error SellerCannotFund();
    error NotParty();
    error NotFunded();
    error NotAuthorizedToCancel();
    error AlreadySettled();

    // ───────────────────────────── Events ─────────────────────────────
    event Funded(address indexed buyer, address refundAddress, uint128 principal);
    event Paid(
        address indexed caller,
        address payoutAddress,
        uint128 toSeller,
        address refundAddress,
        uint128 refundToBuyer,
        uint16 discountBps
    );
    event Cancelled(address indexed caller, uint128 refunded);

    uint256 private constant MAX_TIERS = 10;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ───────────────────────────── Storage ────────────────────────────
    /// @notice The factory allowed to call `initialize`. Set to `msg.sender` (the factory) by the constructor.
    address public immutable factory;

    address private _seller;
    uint64 private _dueDate;
    Status private _status;
    bool private _initialized;
    address private _token;
    bytes32 private _invoiceRef;
    uint128 private _principal;
    address private _payoutAddress; // zero if the seller gave none (or gave the seller's own address)
    address private _buyer;
    address private _refundAddress; // zero if the buyer gave none (or gave their own address)
    /// @dev Packed tiers, `(cutoff << 16) | discountBps`; Solidity packs three uint80 per slot.
    uint80[] private _tiers;

    // ─────────────────────────── Constructor ──────────────────────────
    /// @notice Runs once, when the factory deploys the implementation.
    /// @dev Final behaviour: `factory = msg.sender` and the implementation is marked initialised, so nobody
    ///      can initialise the implementation itself.
    constructor() {
        factory = msg.sender;
        _initialized = true;
    }

    // ───────────────────────────── Writes ─────────────────────────────

    /// @notice Initialise a freshly cloned invoice. Callable once, and only by the factory.
    /// @dev Checks run in this order, and each reverts with the named error:
    ///      1. `msg.sender != factory` → `NotFactory`
    ///      2. already initialised → `AlreadyInitialized` (always true on the implementation itself)
    ///      3. `invoiceRef == 0` → `EmptyInvoiceRef`
    ///      4. `principal == 0` → `InvalidPrincipal`
    ///      5. `dueDate <= block.timestamp` → `DueDateNotInFuture`
    ///      6. `tiers.length > 10` → `TooManyTiers`
    ///      7. for each tier, in order, and for each tier in this order:
    ///         `cutoff <= previousCutoff` (the first tier's previous cutoff is 0) → `TiersNotAscending`;
    ///         `cutoff > dueDate` → `TierAfterDueDate`;
    ///         `discountBps > 10_000` → `DiscountTooLarge`
    ///      8. `!TIP20_FACTORY.isTIP20(token)` (TIP-20 prefix and code present) → `NotTIP20`
    ///
    ///      Effects: stores the arguments; `payoutAddress` is stored only if it is non-zero and differs from
    ///      `seller`; sets `status = Active`. Zero tiers is allowed (the invoice then always pays the full
    ///      principal). A tier whose cutoff equals `dueDate` is allowed. Emits no event.
    /// @param seller The invoice seller (the factory passes its own caller).
    /// @param invoiceRef 32-byte UTF-8 reference; also the memo on every transfer.
    /// @param token A TIP-20 token.
    /// @param principal Amount to be locked, in token base units (6 decimals).
    /// @param dueDate Unix timestamp; must be in the future.
    /// @param tiers Up to 10 discount tiers with strictly ascending cutoffs.
    /// @param payoutAddress Where the seller's share goes; address(0) means the seller.
    function initialize(
        address seller,
        bytes32 invoiceRef,
        address token,
        uint128 principal,
        uint64 dueDate,
        DiscountTier[] calldata tiers,
        address payoutAddress
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        if (invoiceRef == bytes32(0)) revert EmptyInvoiceRef();
        if (principal == 0) revert InvalidPrincipal();
        if (dueDate <= block.timestamp) revert DueDateNotInFuture();
        uint256 count = tiers.length;
        if (count > MAX_TIERS) revert TooManyTiers();

        uint64 previousCutoff;
        for (uint256 i; i < count; ++i) {
            DiscountTier calldata tier = tiers[i];
            if (tier.cutoff <= previousCutoff) revert TiersNotAscending();
            if (tier.cutoff > dueDate) revert TierAfterDueDate();
            if (tier.discountBps > BPS_DENOMINATOR) revert DiscountTooLarge();
            previousCutoff = tier.cutoff;
            _tiers.push(uint80((uint256(tier.cutoff) << 16) | tier.discountBps));
        }

        if (!StdPrecompiles.TIP20_FACTORY.isTIP20(token)) revert NotTIP20();

        _initialized = true;
        _seller = seller;
        _dueDate = dueDate;
        _token = token;
        _invoiceRef = invoiceRef;
        _principal = principal;
        if (payoutAddress != address(0) && payoutAddress != seller) _payoutAddress = payoutAddress;
    }

    /// @notice Lock the full principal in escrow. The caller becomes the buyer.
    /// @dev Checks, in order: `status != Active` → `NotActive`; `msg.sender == seller` → `SellerCannotFund`.
    ///      Effects (written before the token call): `buyer = msg.sender`; `refundAddress` stored only if it
    ///      is non-zero and differs from `msg.sender`; `status = Funded`.
    ///      Interaction: `ITIP20(token).transferFromWithMemo(msg.sender, address(this), principal, invoiceRef)`.
    ///      The caller must have approved this invoice for at least `principal`; if the pull fails the whole
    ///      call reverts (with the token's own error) and no state changes.
    ///      Emits `Funded(buyer, resolvedRefundAddress, principal)`.
    /// @param refundAddress Where the buyer's discount and any cancellation refund go; address(0) means the buyer.
    function fund(address refundAddress) external {
        if (_status != Status.Active) revert NotActive();
        if (msg.sender == _seller) revert SellerCannotFund();

        _buyer = msg.sender;
        if (refundAddress != address(0) && refundAddress != msg.sender) _refundAddress = refundAddress;
        _status = Status.Funded;

        uint128 principal = _principal;
        ITIP20(_token).transferFromWithMemo(msg.sender, address(this), principal, _invoiceRef);
        emit Funded(msg.sender, _refund(), principal);
    }

    /// @notice Settle a funded invoice at the discount tier in force now.
    /// @dev Checks, in order: caller is neither seller nor buyer → `NotParty`; `status != Funded` → `NotFunded`.
    ///      `bps = activeDiscount(block.timestamp)`; `refund = principal * bps / 10_000` rounded down;
    ///      `toSeller = principal - refund` (any rounding remainder goes to the seller).
    ///      Effects (before transfers): `status = Paid`.
    ///      Interactions, both with `invoiceRef` as the memo: `transferWithMemo(payoutAddress, toSeller)`, then,
    ///      only if `refund > 0`, `transferWithMemo(refundAddress, refund)` (both resolved).
    ///      Emits `Paid(msg.sender, payout, toSeller, refundAddr, refund, bps)`.
    ///      A payout or refund address is never an authorised caller.
    function triggerPayment() external {
        if (msg.sender != _seller && msg.sender != _buyer) revert NotParty();
        if (_status != Status.Funded) revert NotFunded();

        uint16 bps = _activeDiscount(uint64(block.timestamp));
        uint128 principal = _principal;
        uint128 refundAmount = uint128((uint256(principal) * bps) / BPS_DENOMINATOR);
        uint128 toSeller = principal - refundAmount;
        address payout = _payout();
        address refundTo = _refund();

        _status = Status.Paid;

        ITIP20 token = ITIP20(_token);
        bytes32 invoiceRef = _invoiceRef;
        token.transferWithMemo(payout, toSeller, invoiceRef);
        if (refundAmount > 0) token.transferWithMemo(refundTo, refundAmount, invoiceRef);

        emit Paid(msg.sender, payout, toSeller, refundTo, refundAmount, bps);
    }

    /// @notice Cancel an invoice that has not been paid.
    /// @dev Authorised if `msg.sender == seller` (while Active or Funded, even after the due date), or if
    ///      `msg.sender == buyer && block.timestamp > dueDate`. Before funding the buyer is address(0), so only
    ///      the seller can cancel an unfunded invoice. Checks, in order: not authorised → `NotAuthorizedToCancel`;
    ///      `status` is `Paid` or `Cancelled` → `AlreadySettled`.
    ///      Effects (before the transfer): `status = Cancelled`.
    ///      Interaction, only if the invoice was Funded: `transferWithMemo(refundAddress, principal)` with
    ///      `invoiceRef` as the memo. Emits `Cancelled(msg.sender, refunded)` where `refunded` is `principal`
    ///      if it was Funded, otherwise 0. An Active invoice moves no tokens.
    function cancel() external {
        if (msg.sender != _seller && !(msg.sender == _buyer && block.timestamp > _dueDate)) {
            revert NotAuthorizedToCancel();
        }
        Status status = _status;
        if (status != Status.Active && status != Status.Funded) revert AlreadySettled();

        _status = Status.Cancelled;

        uint128 refunded;
        if (status == Status.Funded) {
            refunded = _principal;
            ITIP20(_token).transferWithMemo(_refund(), refunded, _invoiceRef);
        }
        emit Cancelled(msg.sender, refunded);
    }

    // ───────────────────────────── Reads ──────────────────────────────

    /// @notice The full state of the invoice, readable by anyone.
    /// @dev `payoutAddress` is returned resolved (the seller if none was given). `refundAddress` is returned
    ///      resolved (the buyer if none was given), and is address(0) while there is no buyer. `buyer` is
    ///      address(0) until funded. `tiers` are returned in creation order. `status` reflects the latest write.
    function getInvoice() external view returns (InvoiceState memory) {
        uint256 count = _tiers.length;
        DiscountTier[] memory tiers = new DiscountTier[](count);
        for (uint256 i; i < count; ++i) {
            uint80 packed = _tiers[i];
            tiers[i] = DiscountTier({cutoff: uint64(packed >> 16), discountBps: uint16(packed)});
        }
        return InvoiceState({
            invoiceRef: _invoiceRef,
            seller: _seller,
            payoutAddress: _payout(),
            buyer: _buyer,
            refundAddress: _refund(),
            token: _token,
            principal: _principal,
            dueDate: _dueDate,
            tiers: tiers,
            status: _status
        });
    }

    /// @notice The discount that applies at `timestamp`.
    /// @dev Returns `discountBps` of the first tier with `timestamp < cutoff` (strict: a timestamp equal to a
    ///      cutoff falls into the next tier), or 0 if there is none (including when there are no tiers).
    ///      Pure function of the stored tiers; does not look at the invoice status.
    /// @param timestamp A unix timestamp in seconds.
    function activeDiscount(uint64 timestamp) external view returns (uint16) {
        return _activeDiscount(timestamp);
    }

    // ──────────────────────────── Internals ───────────────────────────

    function _activeDiscount(uint64 timestamp) private view returns (uint16) {
        uint256 count = _tiers.length;
        for (uint256 i; i < count; ++i) {
            uint80 packed = _tiers[i];
            // forge-lint: disable-next-line(unsafe-typecast)
            if (timestamp < uint64(packed >> 16)) return uint16(packed); // low 16 bits are discountBps
        }
        return 0;
    }

    /// @dev The payout address, or the seller if none was given.
    function _payout() private view returns (address) {
        address payout = _payoutAddress;
        return payout == address(0) ? _seller : payout;
    }

    /// @dev The refund address, or the buyer if none was given.
    function _refund() private view returns (address) {
        address refund = _refundAddress;
        return refund == address(0) ? _buyer : refund;
    }
}
