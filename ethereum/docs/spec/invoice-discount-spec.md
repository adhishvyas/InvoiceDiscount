# InvoiceDiscount on Ethereum: Specification

> Status: implemented, November 2026. Deployed on Sepolia (`contracts/deployments/sepolia.json`); test findings summarised in [`../plan/test-lane-findings.md`](../plan/test-lane-findings.md); end-to-end run in [`../e2e-checklist.md`](../e2e-checklist.md). This is a port of the Tempo implementation: the base spec ([`../../../tempo/docs/spec/invoice-discount-spec.md`](../../../tempo/docs/spec/invoice-discount-spec.md), "Tempo base") plus the `settleDirect()` contract function and its frontend actions from the MPP spec ([`../../../tempo/docs/spec/mpp-pay-now-spec.md`](../../../tempo/docs/spec/mpp-pay-now-spec.md), "Tempo MPP"). The MPP server is not ported. The Mesh Pay now spec ([`mesh-pay-now-spec.md`](mesh-pay-now-spec.md)) builds on this one.

---

## 1. Problem and goal

Invoices are usually paid net-30 or net-60. A seller who needs the money sooner can offer the buyer a discount for paying early, and a buyer who could pay early now has a reason to. InvoiceDiscount puts those discount terms in a smart contract, settled in a stablecoin. The Tempo version is implemented; this spec ports the same functionality to Ethereum (Sepolia testnet).

1. A seller creates an invoice. It has a human-readable invoice reference, a principal amount, an ERC-20 token, a due date, up to 10 early-payment discount tiers, and an optional payout address.
2. A wallet other than the seller's funds the invoice by locking the full principal in escrow. That wallet becomes the buyer, and can name an optional refund address.
3. The seller or the buyer triggers payment. The contract applies the discount tier in force at that moment, sends the discounted amount to the seller's payout address, and sends the discount to the buyer's refund address.
4. The seller can cancel at any time before payment. The buyer can cancel only after the due date. If the invoice was funded, the full principal goes to the buyer's refund address.
5. **Direct settlement:** if tokens have been sent straight to an Active invoice's address (by a plain transfer, or later by Mesh), anyone can call `settleDirect()` to mark it Paid and forward the balance to the payout address.
6. Anyone can read an invoice's full state.
7. A web frontend handles creating, looking up, funding, paying, settling and cancelling invoices on Sepolia.

This is a proof of concept using testnet stablecoins.

---

## 2. What changes from Tempo

The contract logic, lifecycle, discount maths and UI flows are the same as on Tempo. These are the differences, and what this spec does about each:

| Topic | Tempo | Ethereum (this spec) |
|---|---|---|
| Network | Moderato, chain 42431, sub-second finality | **Sepolia**, chain 11155111, ~12 s blocks |
| Token standard | TIP-20 (precompile, always 6 decimals) | **ERC-20**, decimals vary per token |
| Token check at creation | `TIP20_FACTORY.isTIP20(token)` → `NotTIP20` | **`token.code.length > 0`** → `InvalidToken`. The frontend offers a fixed token list (§5.1). Fee-on-transfer and rebasing tokens are unsupported and documented as a risk (§3.9) |
| Transfers | `transferWithMemo` / `transferFromWithMemo` carry `invoiceRef` as the memo | ERC-20 has no memo. Plain transfers through OpenZeppelin **`SafeERC20`** (handles tokens that don't return `bool`). **Every escrow event carries `invoiceRef`** (§3.6) to keep reconciliation by reference |
| Gas | Paid in a stablecoin, sponsored by the app's fee payer | **Paid in Sepolia ETH by whoever sends the transaction.** No sponsorship |
| Wallet | Tempo Wallet (passkeys), injected as fallback | **Injected wallets** (MetaMask etc.) only |
| approve + fund | One batched `0x76` transaction on Tempo Wallet | **EIP-5792 `wallet_sendCalls`** with atomic batching when the wallet reports it as `supported`; otherwise two transactions (§5.2) |
| Pay now | MPP server + `settleDirect()` | `settleDirect()` only, with the Finish settlement / Accept and settle buttons. Mesh adds the inbound payment later |
| Storage cost | 250,000 gas per new slot, 1,000 gas per byte of new code | ~22,100 gas per new slot, 200 gas per byte. The clone design and packed layout are kept anyway: they still save gas, and Mesh relies on clone detection |
| Log queries | RPC caps `eth_getLogs` at 100,000 blocks; we page at 50,000 | Depends on the RPC provider; we page at 10,000 blocks (§5.4) |
| Explorer / verification | `explore.testnet.tempo.xyz`, `contracts.tempo.xyz` | `sepolia.etherscan.io`, Sourcify verification (no API key) |
| Testnet funds | `tempo_fundAddress` RPC | Sepolia ETH and token faucets (§6) |

Everything not in this table behaves as in the Tempo base spec and Tempo MPP §3.

---

## 3. Contracts

Two contracts, in `ethereum/contracts/src/`:

- **`InvoiceEscrow.sol`**: the logic for one invoice. Deployed once as an implementation; each invoice is an EIP-1167 clone of it.
- **`InvoiceFactory.sol`**: deploys and initialises clones.

Dependencies: OpenZeppelin `Clones`, `IERC20` and `SafeERC20`. Solidity, Foundry, custom errors.

Once implemented, the interface is frozen at git tag **`ethereum-interface-v1`**. Changing it needs approval and a new tag, as on Tempo.

### 3.1 Types

Unchanged from Tempo:

```solidity
enum Status { Active, Funded, Paid, Cancelled }

struct DiscountTier {
    uint64 cutoff;       // unix timestamp (seconds). Applies if payment is triggered before this time
    uint16 discountBps;  // basis points, 1500 = 15%, max 10_000
}

struct InvoiceState {
    bytes32 invoiceRef;     // UTF-8, right-padded with zeros
    address seller;
    address payoutAddress;  // resolved: seller if none was given
    address buyer;          // address(0) until funded
    address refundAddress;  // resolved: buyer if none was given; address(0) until funded
    address token;
    uint128 principal;      // in the token's smallest unit
    uint64  dueDate;
    DiscountTier[] tiers;
    Status  status;
}
```

### 3.2 Invoice reference

As on Tempo: a `bytes32` holding a UTF-8 string of at most 32 bytes, left-aligned and zero-padded (`viem` `stringToHex(ref, { size: 32 })`). Must not be `bytes32(0)` → `EmptyInvoiceRef`. Not checked for UTF-8 validity. Uniqueness is not enforced on-chain; the frontend rejects a reference the connected seller has already used (§5.3).

The difference: it is no longer a transfer memo. It appears in `InvoiceCreated` and in every escrow event (§3.6), so a block explorer or indexer can match each lifecycle step and each token transfer (via the clone address in the same transaction) to the physical invoice.

### 3.3 Storage (InvoiceEscrow)

Same layout as Tempo: default payout and refund addresses stored as `address(0)` and resolved on read, tiers packed as `uint80` elements (`(cutoff << 16) | discountBps`, three per slot).

| Slot | Fields |
|---|---|
| 0 | `seller` (20 B) · `dueDate` (8 B) · `status` (1 B) · `initialized` (1 B) |
| 1 | `token` (20 B) |
| 2 | `invoiceRef` (32 B) |
| 3 | `principal` (16 B) |
| 4 | `payoutAddress` (20 B), zero if the seller gave none |
| 5 | `buyer` (20 B), written by `fund` |
| 6 | `refundAddress` (20 B), zero if the buyer gave none |
| 7+ | packed `uint80[]` tiers |

The exact layout is up to the implementer. Helpers `_payout()` (payout or seller) and `_refund()` (refund or buyer) resolve the defaults.

### 3.4 InvoiceFactory

Unchanged from Tempo:

```solidity
address public immutable implementation;

constructor()   // implementation = address(new InvoiceEscrow())

function createInvoice(
    bytes32 invoiceRef,
    address token,
    uint128 principal,
    uint64  dueDate,
    DiscountTier[] calldata tiers,
    address payoutAddress      // address(0) = pay the seller
) external returns (address invoice);

event InvoiceCreated(
    address indexed invoice,
    address indexed seller,
    bytes32 indexed invoiceRef,
    address token,
    uint128 principal,
    uint64  dueDate
);
```

`createInvoice` clones the implementation, calls `initialize(msg.sender, …)` in the same transaction (so initialisation can't be front-run), emits `InvoiceCreated` and returns the clone address. The caller becomes the seller.

### 3.5 InvoiceEscrow functions

All token calls use `SafeERC20` (`safeTransfer`, `safeTransferFrom`). Every state change happens before the token call (checks-effects-interactions), so a token that calls back into the escrow (e.g. an ERC-777-style hook) finds the status already updated. No reentrancy guard is needed. Each function emits its event last, after its token calls, so in a transaction's logs the token's `Transfer` events come before the escrow event.

#### `initialize(address seller, bytes32 invoiceRef, address token, uint128 principal, uint64 dueDate, DiscountTier[] tiers, address payoutAddress)`

As Tempo base §3.5: callable once (`AlreadyInitialized`) and only by the factory (`NotFactory`, with `factory` an immutable set in the implementation's constructor, which also marks the implementation initialised). Checks, in this order:

- `invoiceRef != 0` → `EmptyInvoiceRef`
- `principal > 0` → `InvalidPrincipal`
- `dueDate > block.timestamp` → `DueDateNotInFuture`
- `tiers.length <= 10` → `TooManyTiers`
- per tier, in one pass: `cutoff > previousCutoff` (first > 0) → `TiersNotAscending`; `cutoff <= dueDate` → `TierAfterDueDate`; `discountBps <= 10_000` → `DiscountTooLarge`
- **`token.code.length > 0` → `InvalidToken`** (replaces `NotTIP20`). This rejects an EOA or an empty address. It does not prove the contract is an ERC-20. A contract without `transferFrom` usually makes `fund` revert, but one whose `fallback` accepts any call and returns no data passes `SafeERC20`, so `fund` marks the invoice Funded with no tokens moved (§3.9).

Stores `payoutAddress` only if non-zero and different from `seller`. Sets `status = Active`. Zero tiers is allowed. Past cutoffs, zero-discount tiers and non-monotonic discounts are accepted, as on Tempo.

#### `fund(address refundAddress)`

- `status == Active` → `NotActive`; `msg.sender != seller` → `SellerCannotFund`.
- `buyer = msg.sender`. Stores `refundAddress` only if non-zero and different from `msg.sender`.
- `status = Funded`.
- `IERC20(token).safeTransferFrom(msg.sender, address(this), principal)`. Requires a prior `approve`.
- Emits `Funded(buyer, invoiceRef, _refund(), principal)`.

#### `triggerPayment()`

- `msg.sender == seller || msg.sender == buyer` → `NotParty` (an unfunded invoice's `buyer` is `address(0)`, never a party).
- `status == Funded` → `NotFunded`.
- `bps = activeDiscount(block.timestamp)`; `refund = principal * bps / 10_000` (floored); `toSeller = principal - refund`.
- `status = Paid`.
- `safeTransfer(_payout(), toSeller)`, always, even when 0. Then `safeTransfer(_refund(), refund)` only if `refund > 0`.
- Emits `Paid(msg.sender, invoiceRef, _payout(), toSeller, _refund(), refund, bps)`.

A zero-amount `transfer` is legal ERC-20, but a few tokens revert on it. Those tokens can't settle a 100% discount; this is accepted for the PoC (§3.9).

#### `cancel()`

- Authorised if `msg.sender == seller`, or `msg.sender == buyer && block.timestamp > dueDate` → otherwise `NotAuthorizedToCancel`.
- `status == Active || status == Funded` → `AlreadySettled`.
- `status = Cancelled`. If it was Funded: `safeTransfer(_refund(), principal)`.
- Emits `Cancelled(msg.sender, invoiceRef, refunded)`.

#### `settleDirect()`

Ported from Tempo MPP §3.1:

- `status == Active` → `NotActive`.
- `bps = activeDiscount(block.timestamp)`; `due = principal - principal * bps / 10_000`.
- `balance = IERC20(token).balanceOf(address(this))`; `balance > 0` → `NothingToSettle` (also for the seller).
- If `msg.sender != seller`: `balance >= due` → `InsufficientDirectPayment(balance, due)`. The seller may settle for less.
- `status = Paid`. `buyer` and `refundAddress` stay `address(0)`.
- `safeTransfer(_payout(), balance)`: the whole balance, so an overpayment goes to the seller.
- Emits `SettledDirect(msg.sender, invoiceRef, _payout(), balance, bps)`.

Permissionless: anyone can call it, and anyone can send tokens to the clone. The payer is identified off-chain (the `from` of the inbound `Transfer`).

#### `getInvoice() view returns (InvoiceState)` and `activeDiscount(uint64 timestamp) view returns (uint16)`

Unchanged. `getInvoice` returns resolved payout and refund addresses. `activeDiscount` returns the `discountBps` of the first tier with `timestamp < cutoff`, or 0.

The behaviour of `fund`, `triggerPayment`, `cancel`, `settleDirect` and `getInvoice` on the implementation contract itself is undefined.

### 3.6 Events and errors (InvoiceEscrow)

The Tempo events gain an indexed `invoiceRef`, standing in for the memo. Filtering by `invoiceRef` across all clones then works with one `eth_getLogs` call.

```solidity
event Funded(address indexed buyer, bytes32 indexed invoiceRef, address refundAddress, uint128 principal);
event Paid(address indexed caller, bytes32 indexed invoiceRef, address payoutAddress, uint128 toSeller,
           address refundAddress, uint128 refundToBuyer, uint16 discountBps);
event Cancelled(address indexed caller, bytes32 indexed invoiceRef, uint128 refunded);
event SettledDirect(address indexed caller, bytes32 indexed invoiceRef, address payoutAddress,
                    uint256 amount, uint16 discountBps);
```

Errors: as Tempo (`NotFactory`, `AlreadyInitialized`, `EmptyInvoiceRef`, `InvalidPrincipal`, `DueDateNotInFuture`, `TooManyTiers`, `TiersNotAscending`, `TierAfterDueDate`, `DiscountTooLarge`, `NotActive`, `SellerCannotFund`, `NotParty`, `NotFunded`, `NotAuthorizedToCancel`, `AlreadySettled`, `NothingToSettle`, `InsufficientDirectPayment(uint256 balance, uint256 due)`), with `NotTIP20` replaced by `InvalidToken`. `SafeERC20` adds `SafeERC20FailedOperation(address token)`.

### 3.7 Lifecycle

```
createInvoice()       fund(refundAddress)       triggerPayment() / cancel()
     │                       │                            │
     ▼                       ▼                            ▼
  Active ────────────────► Funded ───────────────────► Paid / Cancelled
     │
     │  token transfer into clone, then settleDirect()
     └──────────────────────────────────────────────────► Paid

Seller may cancel: Active or Funded.  Buyer may cancel: Funded, after dueDate.
Seller may not fund their own invoice.
```

### 3.8 Worked example

`INV-2026-0042`: 100,000.00 PYUSD, due in 60 days, 15% until day 15, 10% until day 30.

| Settled on | To payout address | To refund address |
|---|---|---|
| Day 5, `triggerPayment` | 85,000.00 | 15,000.00 |
| Day 20, `triggerPayment` | 90,000.00 | 10,000.00 |
| Day 45, `triggerPayment` | 100,000.00 | 0 |
| Cancelled after funding | 0 | 100,000.00 |
| Day 5, 85,000.00 sent to the clone, then `settleDirect` | 85,000.00 | none (no buyer) |

Every escrow event carries `invoiceRef = "INV-2026-0042"`.

**Block time:** `block.timestamp` is the time of the block that includes the transaction, not the time the user clicked. A transaction sent seconds before a cutoff may be included after it and get the next tier. This is also true on Tempo, but 12 s blocks and a possibly congested mempool make it more likely here. The frontend says so (§5.3).

### 3.9 Token risks to document (not to handle in code)

- **Pause and blocklist:** PYUSD, USDG and USDC can be paused by their issuer. PYUSD and USDG can freeze addresses; USDC can blacklist them. A pause, or a blocked party or payout/refund address, makes `fund`, `triggerPayment`, `cancel` or `settleDirect` revert. Funds stay in escrow until it is lifted. No rescue path.
- **Issuer seizure:** PYUSD's and USDG's issuer can wipe a frozen address's balance (`wipeFrozenAddress`), including an escrow's. A trust assumption about the issuer, like TIP-20's `burnAt`.
- **Fee-on-transfer and rebasing tokens are unsupported.** The contract assumes a transfer of `principal` delivers exactly `principal`. With a fee-on-transfer token, the escrow holds less than `principal` after `fund`, and `triggerPayment` and `cancel` then revert, so the funds are stuck. A rebasing token changes the balance under the escrow. The frontend's token list contains neither kind; a seller calling the factory directly can still pick one.
- **Tokens that revert on zero-amount transfers** can't settle an invoice with a 100% discount through `triggerPayment`.
- **Non-ERC-20 contracts with a permissive `fallback`** pass the `InvalidToken` check, and `SafeERC20` accepts their empty return data, so `fund` succeeds with no tokens moved: the invoice shows Funded with nothing in escrow. The frontend's token list prevents this; a seller calling the factory directly can still pick such a contract.
- **Stray transfers into a clone** stay there unless `settleDirect` takes them. `settleDirect` pays out an Active clone's whole balance, but once the clone is funded through `fund`, `triggerPayment` and `cancel` move `principal` only, so tokens sent before or after funding (or into a Paid or Cancelled clone) stay in it. No rescue path, as on Tempo.

---

## 4. Off-chain components

- **No backend.** The MPP server is Tempo-only and is not ported. The Mesh spec adds `ethereum/mesh-server/` later.
- The frontend talks to Sepolia through an RPC URL from `.env` (§5.1).

---

## 5. Frontend

Location: `ethereum/frontend/`. Start from a copy of `tempo/frontend/` (nothing is shared between chains) and change only what this section lists. Stack: React + Vite + TypeScript + Tailwind + react-router, wagmi + viem.

### 5.1 Configuration

- Chain: `sepolia` from `viem/chains` (chain ID `11155111`).
- Transport: `http(VITE_RPC_URL)`. The RPC must accept a 10,000-block `eth_getLogs` range (§5.4). `ethereum-sepolia.publicnode.com` (50,000) and paid provider plans do; **Alchemy's free tier does not** (10 blocks). See [`verification-notes.md`](verification-notes.md) item 3.
- Connector: `injected()`. Remove the Tempo Wallet connector, `feePayer`, and the `mpp` option.
- If the wallet is on another chain, show a "Switch to Sepolia" button (`useSwitchChain`) and disable writes.
- `.env`: `VITE_RPC_URL`, `VITE_FACTORY_ADDRESS`, `VITE_FACTORY_DEPLOY_BLOCK`. Remove `VITE_MPP_SERVER_URL`.
- Token list (hardcoded, Sepolia). Addresses and decimals confirmed in [`verification-notes.md`](verification-notes.md) items 1a–1c:

  | Token | Address | Decimals | Faucet |
  |---|---|---|---|
  | PYUSD (default) | `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9` | 6 | `faucet.paxos.com` or the Google Cloud Web3 faucet |
  | USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 6 | `faucet.circle.com` |
  | USDG | `0xfBb2A78CceEb415b00300925e464C3E44E6e06b0` | 6 | `faucet.paxos.com` |

  Read `decimals()` and `symbol()` from the token contract rather than trusting the table.
- Explorer links: `https://sepolia.etherscan.io/tx/…` and `/address/…`.

### 5.2 Wallet capabilities and the funding path

Read `useCapabilities()` for the connected account and Sepolia.

| Case | Fund path |
|---|---|
| `atomic.status === 'supported'` | One `useSendCalls` request with `calls: [token.approve(invoice, principal), invoice.fund(refundAddress)]` and `forceAtomic: true`. Wait with `useWaitForCallsStatus` |
| Anything else (`'ready'`, `'unsupported'`, or no EIP-5792 support) | Two transactions: `approve`, wait for its receipt, then `fund` |

`'ready'` means the wallet would first upgrade the account to a smart account (EIP-7702). The PoC doesn't trigger that upgrade; it takes the two-transaction path.

All other writes (`createInvoice`, `triggerPayment`, `cancel`, `settleDirect`) are single transactions through `writeContract`.

Gas: every write costs Sepolia ETH. Show a one-line note with a faucet link on the connect screen, and turn "insufficient funds for gas" errors into "You need Sepolia ETH to pay gas".

Transaction handling: wait for one confirmation (`waitForTransactionReceipt`), which takes about 12 s. Show pending, success or error for each action, including the tx hash with an explorer link as soon as it's known, then refetch `getInvoice`.

### 5.3 Pages

Same routes and behaviour as Tempo base §4.3, with these changes:

| Route | Changes |
|---|---|
| `/` | Single "Connect wallet" button (injected). Sepolia ETH note. Lookup by invoice address unchanged |
| `/create` | Token dropdown from §5.1. Amount converted with the selected token's `decimals()`. Duplicate-reference check unchanged in logic (§5.4) |
| `/invoice/:address` | Actions below. Remove Pay now via MPP and the MPP exchange panel. History adds `SettledDirect` and reads `invoiceRef` from the events |

**Actions on InvoiceDetail:**

| Action | Shown when | Call |
|---|---|---|
| Fund | connected, not seller, `status == Active` | Optional refund address input. Path from §5.2 |
| Trigger payment | `status == Funded`, user is seller or buyer | `invoice.triggerPayment()` |
| Cancel | seller (Active/Funded), or buyer with `now > dueDate` (Funded) | `invoice.cancel()` |
| Finish settlement | `status == Active`, clone balance ≥ amount due now, and balance > 0 | `invoice.settleDirect()`. Anyone connected may click it |
| Accept and settle | seller, `status == Active`, 0 < clone balance < amount due now | Warns "You will receive X instead of Y", then `invoice.settleDirect()` |

"Amount due now" is `principal − floor(principal × activeDiscount(now) / 10_000)`, with `activeDiscount` read from the contract.

Before signing, fund, pay and settle show where money will go, as on Tempo. When the next tier cutoff is less than 5 minutes away, they also say: "A discount tier ends at hh:mm. If the transaction is included after that, the split changes."

### 5.4 Logs and history

- **Duplicate-reference check** and **history** (Tempo `lib/logs.ts`, `lib/history.ts`, `useInvoiceHistory`): same logic, paging `eth_getLogs` from `VITE_FACTORY_DEPLOY_BLOCK`. `LOG_PAGE_SIZE = 10_000n` blocks, which fits the RPCs in §5.1 ([`verification-notes.md`](verification-notes.md) item 3c). Sepolia makes ~7,200 blocks a day, so the scan stays small for the PoC.
- History reads `Funded`, `Paid`, `Cancelled` and `SettledDirect` from the clone, and timestamps from `getBlock`. For a direct settlement it also shows the inbound ERC-20 `Transfer` events into the clone (sender, amount), so the payer is visible.
- Keep the `localStorage` cache, wrapped in try/catch.

### 5.5 Helpers

- `toUnits(amount, decimals) = parseUnits(amount, decimals)` and `fromUnits(units, decimals) = formatUnits(units, decimals)`, with `decimals` from the token. Remove any hardcoded 6.
- `encodeRef` / `decodeRef` unchanged (trim, max 32 UTF-8 bytes).

---

## 6. Tests (Foundry)

Same suite as Tempo base §5 and Tempo MPP §6.1, run with a plain `forge test` (no `network = "tempo"` in `foundry.toml`).

- **Unit tests (`test/unit/`):** a `MockERC20` in `test/` (OpenZeppelin `ERC20`, 6 decimals, public `mint`). Tests use `deal` or `mint` to fund actors.
- **Fork tests (`test/fork/`):** run against Sepolia (`SEPOLIA_RPC_URL=… FOUNDRY_PROFILE=fork forge test`) with the real PYUSD and USDC contracts. Fund actors with `deal(token, actor, amount)`, which works on both proxies ([`verification-notes.md`](verification-notes.md) item 5).
- **No smoke tests:** all tests are written by the black-box test lane, so the contract author's `test/smoke/` from Tempo was dropped.

Changes to the Tempo test list:

| Test | Change |
|---|---|
| `test_TransfersCarryInvoiceRefMemo` | Replaced by **`test_EventsCarryInvoiceRef`**: `Funded`, `Paid`, `Cancelled` and `SettledDirect` each emit the invoice's `invoiceRef` |
| `test_ValidationErrors` | `NotTIP20` case replaced by `InvalidToken` for an EOA and for `address(0)` |
| **`test_NoReturnValueToken`** (new) | A USDT-style mock whose `transfer`/`transferFrom` return nothing: fund, pay and cancel all work through `SafeERC20` |
| **`test_FalseReturnValueToken`** (new) | A mock that returns `false` instead of reverting: `fund` reverts `SafeERC20FailedOperation` and the state is unchanged |
| **`test_ReentrantTokenCannotDoubleSpend`** (new) | A mock that calls back into `triggerPayment` / `cancel` / `settleDirect` during `transfer`: the inner call reverts (status already updated) |
| Fork: `test_Fork_PyusdLifecycle`, `test_Fork_UsdcLifecycle` (new) | Create, fund, pay with a discount and cancel, against the real Sepolia tokens |

All other tests (tier boundaries, rounding, defaults, authorisation, factory, `settleDirect` cases) carry over unchanged apart from the token setup.

Frontend: carry over the Tempo vitest suites, with tests added for the §5.2 path selection and for `toUnits`/`fromUnits` with decimals other than 6.

---

## 7. Project layout and commands

```
ethereum/
  contracts/                 # Foundry project
    src/InvoiceEscrow.sol
    src/InvoiceFactory.sol
    test/unit/  test/fork/  test/mocks/
    script/Deploy.s.sol      # deploys the factory (which deploys the implementation)
    deployments/sepolia.json # factory, implementation, deploy block
  frontend/                  # Vite + React + wagmi, copied from tempo/frontend
  docs/
    spec/invoice-discount-spec.md
    spec/mesh-pay-now-spec.md
```

- Build / test: `forge build`, `forge test -vvv`. Fork suite: `SEPOLIA_RPC_URL=<url> FOUNDRY_PROFILE=fork forge test -vvv`.
- Deploy (the user broadcasts): `forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --account sepolia-deployer --broadcast --verify --verifier sourcify --gas-estimate-multiplier 800`. No API key is needed. The deployer needs Sepolia ETH. The multiplier is needed because Sepolia charges about 7× more gas to store contract code than forge 1.8.5's local simulation (the factory deploy uses about 9.8M gas); without it the deploy runs out of gas.
- Frontend: `corepack pnpm dev | build | lint | test`, and `corepack pnpm sync-abi` after a contract change (frontend ABIs only).
- Testnet funds: Sepolia ETH from a faucet; PYUSD and USDC from the faucets in §5.1.

These commands are also in the Ethereum section of the root `CLAUDE.md`.

---

## 8. Verified before implementing

Results are in [`verification-notes.md`](verification-notes.md) (node S1, 2026-10-30).

1. **Token addresses and decimals:** confirmed for PYUSD, USDC and USDG, all 6 decimals (items 1a–1c). Mesh's Sepolia contracts are still unknown (item 1d); fallback: settled in the Mesh plan, and a mismatch only changes the token list.
2. **Token behaviour:** no transfer fee, zero-amount transfers succeed, pause/freeze/blacklist/wipe as in §3.9 (items 2a–2c).
3. **`eth_getLogs` limits:** `LOG_PAGE_SIZE = 10_000n`; Alchemy free tier unusable (items 3a–3c).
4. **EIP-5792:** wagmi hooks and viem's `forceAtomic` confirmed. A MetaMask EOA reports `ready` or nothing, so it takes the two-transaction path (§5.2). The live MetaMask response is checked in the browser in F3 and I1 (item 4b); fallback: the two-transaction path.
5. **`deal`** works on the forked proxies (item 5).

---

## 9. Out of scope

- The MPP server and Pay now via MPP (Tempo-only). Pay with Mesh is a separate spec.
- Gas sponsorship (paymasters, ERC-4337/7677) and triggering an EIP-7702 account upgrade.
- EIP-2612 `permit` funding.
- An on-chain token allowlist, and support for fee-on-transfer or rebasing tokens.
- Listing a user's invoices, or lookup by reference in the UI (the indexed events make both possible later).
- Changing payout or refund addresses after they are set; partial funding or payment; changing terms after creation.
- Upgradeability, admin keys, and rescuing stuck funds.
- Contract-level enforcement of unique invoice references.
- Mainnet and L2 deployments.
