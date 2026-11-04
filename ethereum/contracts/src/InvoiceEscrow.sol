// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Lifecycle state of an invoice.
enum Status {
    Active, // created, not yet funded
    Funded, // principal is locked in escrow
    Paid, // settled: split between payout and refund addresses, or forwarded by settleDirect
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
/// @notice Escrow for one invoice, settled in an ERC-20 token or in native ETH (`token == address(0)`).
///         Deployed once as an implementation; each invoice is an EIP-1167 clone created and initialised
///         atomically by `InvoiceFactory`.
/// @dev INTERFACE FREEZE (tag `ethereum-interface-v2`): signatures, events, errors and the behaviour
///      described in the NatSpec below are final.
///
///      **ERC-20 invoices** behave exactly as in `ethereum-interface-v1`, with two additions: `fund` rejects any
///      `msg.value` (`IncorrectValue(sent, 0)`), and `receive()` rejects plain ETH (`NativeNotAccepted`).
///
///      **ETH invoices** (`token == address(0)`, the "native" token):
///      - `fund` takes the principal as `msg.value` and makes no token call.
///      - Every outgoing payment (`triggerPayment`, `cancel`, `settleDirect`) goes through the internal
///        `_send(to, amount)`:
///        - `amount == 0` → nothing is sent and no event is emitted;
///        - otherwise a call to `to` with `value: amount`, a gas cap of `PUSH_GAS = 50_000`, empty calldata and
///          **no return data copied** (assembly `call` with out size 0), so a recipient can neither burn the
///          caller's gas nor return-bomb it;
///        - if that call fails, nothing reverts: `owed[to] += amount` and
///          `PayoutDeferred(to, invoiceRef, amount)` is emitted. The recipient later calls `withdraw`.
///        The escrow's own events (`Paid`, `Cancelled`, `SettledDirect`) report the same amounts whether each
///        payment was pushed or deferred, and are emitted after the payments, as in v1.
///      - Direct payments arrive through `receive()` (only while Active), which emits `Received`.
///      - `settleDirect` uses `address(this).balance` as the balance.
///      Credits (`owed`) only arise once an invoice is Paid or Cancelled, so they never count towards an Active
///      invoice's balance.
///
///      The implementation contract itself is never usable as an invoice: besides being marked initialised,
///      its constructor sets its status to `Cancelled`, so its `fund`, `receive`, `settleDirect` and
///      `triggerPayment` revert with their status errors.
///
///      All token calls go through OpenZeppelin `SafeERC20` (`safeTransfer`, `safeTransferFrom`):
///      - a token that returns nothing is accepted (as long as it has code);
///      - a token that returns `false` makes the call revert with `SafeERC20FailedOperation(token)`;
///      - a token that reverts has its revert data bubbled up unchanged.
///      Every state change is written before the token call or ETH send (checks-effects-interactions), so a
///      token or ETH recipient that calls back into the escrow during a transfer finds the status already
///      updated, and the re-entered `fund` / `triggerPayment` / `cancel` / `settleDirect` reverts with that
///      function's status error (`receive()` with `NotActive`). A re-entered `withdraw` finds the caller's
///      credit already zeroed (`NothingToWithdraw`). There is no reentrancy guard.
///
///      Every escrow event except `Withdrawn` carries the invoice's `invoiceRef` (indexed), in place of
///      Tempo's transfer memo.
///
///      Storage layout (clones): slot 0 = seller (20 B) | dueDate (8 B) | status (1 B) | initialized (1 B);
///      1 token; 2 invoiceRef; 3 principal; 4 payoutAddress (zero if none); 5 buyer; 6 refundAddress
///      (zero if none); 7 packed tiers (length, then three tiers per slot); 8 the `owed` mapping. The
///      implementation is free to change this layout, but must not use more fresh slots.
contract InvoiceEscrow {
    using SafeERC20 for IERC20;

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
    error InvalidToken();
    error NotActive();
    error SellerCannotFund();
    error NotParty();
    error NotFunded();
    error NotAuthorizedToCancel();
    error AlreadySettled();
    error NothingToSettle();
    error InsufficientDirectPayment(uint256 balance, uint256 due);
    /// @notice `fund` was sent the wrong `msg.value`: `expected` is `principal` (ETH invoice) or 0 (ERC-20).
    error IncorrectValue(uint256 sent, uint256 expected);
    /// @notice `withdraw` by an account with no credit.
    error NothingToWithdraw();
    /// @notice `withdraw`'s send to `to` failed; the whole call reverts, so the credit is kept.
    error WithdrawFailed();
    /// @notice Plain ETH sent to an ERC-20 invoice.
    error NativeNotAccepted();

    // ───────────────────────────── Events ─────────────────────────────
    event Funded(address indexed buyer, bytes32 indexed invoiceRef, address refundAddress, uint128 principal);
    event Paid(
        address indexed caller,
        bytes32 indexed invoiceRef,
        address payoutAddress,
        uint128 toSeller,
        address refundAddress,
        uint128 refundToBuyer,
        uint16 discountBps
    );
    event Cancelled(address indexed caller, bytes32 indexed invoiceRef, uint128 refunded);
    event SettledDirect(
        address indexed caller, bytes32 indexed invoiceRef, address payoutAddress, uint256 amount, uint16 discountBps
    );
    /// @notice Plain ETH accepted by `receive()` on an Active ETH invoice (`amount` may be 0).
    event Received(address indexed from, bytes32 indexed invoiceRef, uint256 amount);
    /// @notice An ETH payment to `to` failed and was credited to `owed[to]` instead.
    event PayoutDeferred(address indexed to, bytes32 indexed invoiceRef, uint256 amount);
    /// @notice `account` withdrew its whole credit, `amount`, to `to`.
    event Withdrawn(address indexed account, address to, uint256 amount);

    /// @dev Gas forwarded with each pushed ETH payment (`_send`). Private: not part of the ABI.
    uint256 private constant PUSH_GAS = 50_000;
    uint256 private constant MAX_TIERS = 10;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @dev The `token` value that means native ETH.
    address private constant NATIVE = address(0);

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
    /// @notice ETH credited to `account` by a failed push (see `_send`), withdrawable with `withdraw`.
    ///         Always 0 on an ERC-20 invoice.
    mapping(address account => uint256 amount) public owed;

    // ─────────────────────────── Constructor ──────────────────────────
    /// @notice Runs once, when the factory deploys the implementation.
    /// @dev Final behaviour: `factory = msg.sender`; the implementation is marked initialised, so nobody
    ///      can initialise the implementation itself; and its status is `Cancelled`, so it can't be funded or
    ///      take ETH (its token is `address(0)`, which would otherwise make it look like an Active ETH invoice).
    constructor() {
        factory = msg.sender;
        _initialized = true;
        _status = Status.Cancelled;
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
    ///      8. `token != address(0) && token.code.length == 0` (an EOA, or any other address without code) →
    ///         `InvalidToken`. `address(0)` is accepted and makes this an ETH invoice. A token with code is
    ///         not proven to be an ERC-20; a contract whose `fallback` accepts any call lets `fund` succeed
    ///         with no tokens moved (spec §3.9).
    ///
    ///      Effects: stores the arguments; `payoutAddress` is stored only if it is non-zero and differs from
    ///      `seller`; sets `status = Active`. Zero tiers is allowed (the invoice then always pays the full
    ///      principal). A tier whose cutoff equals `dueDate` is allowed, as are past cutoffs, zero-discount
    ///      tiers and non-monotonic discounts. Makes no token call and emits no event.
    /// @param seller The invoice seller (the factory passes its own caller).
    /// @param invoiceRef 32-byte UTF-8 reference; carried by every escrow event.
    /// @param token An ERC-20 token (any decimals), or `address(0)` for native ETH (18 decimals).
    ///        Fee-on-transfer and rebasing tokens are unsupported.
    /// @param principal Amount to be locked, in token base units.
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

        if (token != NATIVE && token.code.length == 0) revert InvalidToken();

        _initialized = true;
        _seller = seller;
        _dueDate = dueDate;
        _token = token;
        _invoiceRef = invoiceRef;
        _principal = principal;
        if (payoutAddress != address(0) && payoutAddress != seller) _payoutAddress = payoutAddress;
    }

    /// @notice Lock the full principal in escrow. The caller becomes the buyer.
    /// @dev Checks, in order: `status != Active` → `NotActive`; `msg.sender == seller` → `SellerCannotFund`;
    ///      ETH invoice and `msg.value != principal` → `IncorrectValue(msg.value, principal)`; ERC-20 invoice
    ///      and `msg.value != 0` → `IncorrectValue(msg.value, 0)`.
    ///      Effects (written before any token call): `buyer = msg.sender`; `refundAddress` stored only if it
    ///      is non-zero and differs from `msg.sender`; `status = Funded`.
    ///      Interaction, ERC-20 only: `IERC20(token).safeTransferFrom(msg.sender, address(this), principal)`.
    ///      The caller must have approved this invoice for at least `principal`. If the pull fails (the token
    ///      reverts, or returns `false` → `SafeERC20FailedOperation(token)`) the whole call reverts and no state
    ///      changes. ETH: no interaction (the principal arrived as `msg.value`).
    ///      Emits `Funded(buyer, invoiceRef, resolvedRefundAddress, principal)`.
    /// @param refundAddress Where the buyer's discount and any cancellation refund go; address(0) means the buyer.
    function fund(address refundAddress) external payable {
        if (_status != Status.Active) revert NotActive();
        if (msg.sender == _seller) revert SellerCannotFund();
        uint128 principal = _principal;
        address token = _token;
        uint256 expected = token == NATIVE ? principal : 0;
        if (msg.value != expected) revert IncorrectValue(msg.value, expected);

        _buyer = msg.sender;
        if (refundAddress != address(0) && refundAddress != msg.sender) _refundAddress = refundAddress;
        _status = Status.Funded;

        if (token != NATIVE) IERC20(token).safeTransferFrom(msg.sender, address(this), principal);
        emit Funded(msg.sender, _invoiceRef, _refund(), principal);
    }

    /// @notice Settle a funded invoice at the discount tier in force now.
    /// @dev Checks, in order: caller is neither seller nor buyer → `NotParty`; `status != Funded` → `NotFunded`.
    ///      `bps = activeDiscount(block.timestamp)`; `refund = principal * bps / 10_000` rounded down;
    ///      `toSeller = principal - refund` (any rounding remainder goes to the seller).
    ///      Effects (before transfers): `status = Paid`.
    ///      Interactions: `safeTransfer(payoutAddress, toSeller)`, always, even when `toSeller` is 0; then,
    ///      only if `refund > 0`, `safeTransfer(refundAddress, refund)` (both addresses resolved).
    ///      ETH: `_send(payoutAddress, toSeller)` then `_send(refundAddress, refund)`, in that order; each is
    ///      skipped when its amount is 0, and a failed send is credited rather than reverting.
    ///      Emits `Paid(msg.sender, invoiceRef, payout, toSeller, refundAddr, refund, bps)`.
    ///      A payout or refund address is never an authorised caller.
    function triggerPayment() external {
        address buyer = _buyer;
        if (msg.sender != _seller && (buyer == address(0) || msg.sender != buyer)) revert NotParty();
        if (_status != Status.Funded) revert NotFunded();

        uint16 bps = _activeDiscount(uint64(block.timestamp));
        uint128 principal = _principal;
        uint128 refundAmount = uint128((uint256(principal) * bps) / BPS_DENOMINATOR);
        uint128 toSeller = principal - refundAmount;
        address payout = _payout();
        address refundTo = _refund();

        _status = Status.Paid;

        _pay(payout, toSeller);
        if (refundAmount > 0) _pay(refundTo, refundAmount);

        emit Paid(msg.sender, _invoiceRef, payout, toSeller, refundTo, refundAmount, bps);
    }

    /// @notice Cancel an invoice that has not been paid.
    /// @dev Authorised if `msg.sender == seller` (while Active or Funded, even after the due date), or if
    ///      `msg.sender == buyer && block.timestamp > dueDate`. Before funding the buyer is address(0), so only
    ///      the seller can cancel an unfunded invoice. Checks, in order: not authorised → `NotAuthorizedToCancel`;
    ///      `status` is `Paid` or `Cancelled` → `AlreadySettled`.
    ///      Effects (before the transfer): `status = Cancelled`.
    ///      Interaction, only if the invoice was Funded: `safeTransfer(refundAddress, principal)` (resolved);
    ///      ETH: `_send(refundAddress, principal)`.
    ///      Emits `Cancelled(msg.sender, invoiceRef, refunded)` where `refunded` is `principal` if it was
    ///      Funded, otherwise 0. An Active invoice moves no tokens.
    function cancel() external {
        address buyer = _buyer;
        if (msg.sender != _seller && !(buyer != address(0) && msg.sender == buyer && block.timestamp > _dueDate)) {
            revert NotAuthorizedToCancel();
        }
        Status status = _status;
        if (status != Status.Active && status != Status.Funded) revert AlreadySettled();

        _status = Status.Cancelled;

        uint128 refunded;
        if (status == Status.Funded) {
            refunded = _principal;
            _pay(_refund(), refunded);
        }
        emit Cancelled(msg.sender, _invoiceRef, refunded);
    }

    /// @notice Settle an Active invoice from tokens or ETH sent straight to this clone (a plain transfer, or Mesh).
    /// @dev Permissionless. `bps = activeDiscount(block.timestamp)`;
    ///      `due = principal - principal * bps / 10_000` (the discount is floored, as in `triggerPayment`);
    ///      `balance = IERC20(token).balanceOf(address(this))`, or `address(this).balance` for an ETH invoice
    ///      (including ETH forced in without a call, e.g. by `selfdestruct`).
    ///      Checks, in order: `status != Active` → `NotActive`; `balance == 0` → `NothingToSettle` (even for the
    ///      seller); `msg.sender != seller && balance < due` → `InsufficientDirectPayment(balance, due)`. The
    ///      seller may settle for less than `due`.
    ///      Effects (before the transfer): `status = Paid`. `buyer` and `refundAddress` stay address(0).
    ///      Interaction: `safeTransfer(payoutAddress, balance)` (payout resolved), or for ETH
    ///      `_send(payoutAddress, balance)` (credited to the payout address if the push fails). The whole
    ///      balance is forwarded, so any overpayment goes to the payout address.
    ///      Emits `SettledDirect(msg.sender, invoiceRef, payout, balance, bps)`.
    function settleDirect() external {
        if (_status != Status.Active) revert NotActive();

        uint16 bps = _activeDiscount(uint64(block.timestamp));
        uint256 principal = _principal;
        uint256 due = principal - (principal * bps) / BPS_DENOMINATOR;
        address token = _token;
        uint256 balance = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (balance == 0) revert NothingToSettle();
        if (msg.sender != _seller && balance < due) revert InsufficientDirectPayment(balance, due);

        address payout = _payout();
        _status = Status.Paid;

        _pay(payout, balance);

        emit SettledDirect(msg.sender, _invoiceRef, payout, balance, bps);
    }

    /// @notice Send the caller's whole ETH credit (`owed[msg.sender]`) to `to`.
    /// @dev `to` may be any address (for example an EOA, when the caller is a contract that can't receive ETH);
    ///      `address(0)` is not special. Works in any status, and on an ERC-20 invoice (where `owed` is always 0).
    ///      Checks: `owed[msg.sender] == 0` → `NothingToWithdraw`.
    ///      Effects (before the call): `owed[msg.sender] = 0`.
    ///      Interaction: a call to `to` with `value: amount`, empty calldata and **all remaining gas** (no
    ///      `PUSH_GAS` cap: the caller chose `to`). If it fails → `WithdrawFailed`, and the whole call reverts, so
    ///      the credit is kept. Emits `Withdrawn(msg.sender, to, amount)`.
    /// @param to Where the ETH goes.
    function withdraw(address to) external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        owed[msg.sender] = 0;

        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @notice Accept a direct ETH payment (a plain transfer, or Mesh) towards an Active ETH invoice.
    /// @dev Checks, in order: ERC-20 invoice → `NativeNotAccepted`; `status != Active` → `NotActive`.
    ///      Then emits `Received(msg.sender, invoiceRef, msg.value)`; there is no other effect (`settleDirect`
    ///      settles from the balance). Needs more than the 2,300-gas stipend of Solidity's `transfer`/`send`.
    ///      Calls with non-empty calldata that match no function revert (there is no `fallback`).
    receive() external payable {
        if (_token != NATIVE) revert NativeNotAccepted();
        if (_status != Status.Active) revert NotActive();
        emit Received(msg.sender, _invoiceRef, msg.value);
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

    /// @dev Pays `amount` of the invoice's token to `to`: `safeTransfer` for ERC-20, `_send` for ETH.
    function _pay(address to, uint256 amount) private {
        address token = _token;
        if (token == NATIVE) _send(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Pushes ETH with a `PUSH_GAS` cap and no return data copied; a failed push is credited to `owed[to]`.
    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        assembly ("memory-safe") {
            ok := call(PUSH_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            owed[to] += amount;
            emit PayoutDeferred(to, _invoiceRef, amount);
        }
    }
}
