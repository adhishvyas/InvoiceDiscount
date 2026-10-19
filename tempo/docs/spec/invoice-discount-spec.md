# InvoiceDiscount on Tempo: Specification

> Status: draft, October 2026. Background on Tempo itself is in [`../explainer/`](../explainer/).

---

## 1. Problem and goal

Invoices are usually paid net-30 or net-60: the seller gets paid 30 or 60 days after the invoice date. A seller who needs the money sooner can offer the buyer a discount for paying early, for example 10% off for paying within 15 days instead of 30. A buyer may be able to pay early but have no reason to. A discount gives them one. Today these terms are negotiated by email or phone, which costs both sides time.

InvoiceDiscount puts the discount terms in a smart contract, settled in a stablecoin on Tempo:

1. A seller creates an invoice. It has a human-readable invoice reference, a principal amount, a token, a due date, up to 10 early-payment discount tiers, and an optional payout address.
2. A wallet other than the seller's funds the invoice by locking the full principal in escrow. That wallet becomes the buyer, and can name an optional refund address.
3. The seller or the buyer triggers payment. The contract applies the discount tier in force at that moment, sends the discounted amount to the seller's payout address, and sends the discount to the buyer's refund address.
4. The seller can cancel at any time before payment, whether or not the invoice is funded. The buyer can cancel only after the due date. If the invoice was funded, the full principal goes to the buyer's refund address.
5. Anyone can read an invoice's full state.
6. A web frontend handles creating, looking up, funding, paying and cancelling invoices on the Tempo testnet (Moderato).

This is a proof of concept using testnet stablecoins.

---

## 2. Design decisions

| Topic | Decision | Why |
|---|---|---|
| Toolchain | Solidity, Foundry (`forge`, `cast`) | Tempo is an EVM chain, and Foundry is its first-class toolkit |
| One contract per invoice | **Factory + EIP-1167 minimal-proxy clones.** One `createInvoice` transaction deploys the clone and initialises it atomically | Contract creation costs 1,000 gas per byte on Tempo (5–10× Ethereum), and a clone's runtime code is only 45 bytes. Each invoice still gets its own address. Deploying and initialising in one call stops anyone from front-running initialisation |
| Invoice identifier | On-chain: the clone address (`0x…`). Off-chain: the seller's **invoice reference** (e.g. `INV-2026-0042`), which is also the transfer memo | The reference ties every on-chain transfer to the physical invoice |
| Seller | `seller = msg.sender` of `createInvoice` | Nobody can create an invoice in someone else's name |
| Buyer | `buyer = msg.sender` of `fund`. The seller is blocked from funding their own invoice | Any counterparty can fund; self-funding is rejected by the contract |
| Payout address | Optional, set by the seller at creation. Defaults to the seller | Sellers can be paid into a treasury or another wallet |
| Refund address | Optional, set by the buyer **as a parameter of `fund`**. Defaults to the buyer | See §2.1 |
| Who can act | Only the seller and buyer can trigger payment or cancel. Payout and refund addresses only *receive* funds | Receiving addresses get no control over the invoice |
| Token | Any TIP-20, chosen per invoice. The frontend offers a dropdown of testnet stablecoins | |
| Decimals | All TIP-20s use **6** | |
| Amount type | `uint128` principal (fits in a packed slot) | Tempo charges 250,000 gas for each new storage slot |
| Funding | Pull pattern: `approve`, then `fund(refundAddress)`, sent as **one atomic batched `0x76` transaction** where the wallet supports it | TIP-20 has no receive hooks, so a plain transfer to the escrow can't be detected |
| Transfer memo | Every escrow transfer carries the invoice reference as its 32-byte TIP-20 memo | Reconciles on-chain transfers against the physical invoice |
| Gas | Paid in a USD stablecoin, or **sponsored by the app** through a fee payer | Tempo has no native token |
| Wallet | **Tempo Wallet (passkeys)** as the primary connector. Injected EVM wallets (MetaMask etc.) as a fallback | |
| Errors | Solidity custom errors | Idiomatic and cheaper than revert strings |

### 2.1 Why the refund address is a `fund` parameter

There are three ways the buyer could supply a refund address:

| Option | Extra transactions | Notes |
|---|---|---|
| **A. Argument to `fund(refundAddress)`** (chosen) | None | The buyer is only known at `fund`, so this is the earliest moment the address can be given. It's set in the same atomic step that makes them the buyer. Passing `address(0)` means "use my own address" |
| B. Separate `setRefundAddress()` call after funding | One more | Leaves a window where a refund would go to the default. An extra general-lane transaction for no benefit |
| C. Seller sets it at creation | None | Wrong party: the seller doesn't know who will fund, and shouldn't control where the buyer's money goes |

Option A is the cheapest and has no gaps. On Tempo Wallet, the batched `[approve, fund(refundAddress)]` call keeps funding to a single signature. The address is fixed once funded. Changing it later is out of scope (§7).

The seller's payout address follows the same idea: it's an argument to `createInvoice`, the call that makes them the seller.

---

## 3. Contracts

Two contracts, in `tempo/contracts/src/`:

- **`InvoiceEscrow.sol`**: the logic for one invoice. It is deployed once as an implementation, and each invoice is a clone of it.
- **`InvoiceFactory.sol`**: deploys and initialises clones.

Use OpenZeppelin's `Clones` library for EIP-1167, and the TIP-20 interface and precompile helpers from `tempo-std` (`ITIP20` for `transferWithMemo` / `transferFromWithMemo`, `StdPrecompiles.TIP20_FACTORY` for `isTIP20`). See [`verification-notes.md`](verification-notes.md) for the checked API names.

### 3.1 Types

```solidity
enum Status { Active, Funded, Paid, Cancelled }

struct DiscountTier {
    uint64 cutoff;       // unix timestamp (seconds). Applies if payment is triggered before this time
    uint16 discountBps;  // basis points, 1500 = 15%, max 10_000
}

struct InvoiceState {
    bytes32 invoiceRef;     // human-readable reference, UTF-8, right-padded with zeros
    address seller;
    address payoutAddress;  // resolved: seller if none was given
    address buyer;          // address(0) until funded
    address refundAddress;  // resolved: buyer if none was given; address(0) until funded
    address token;
    uint128 principal;
    uint64  dueDate;
    DiscountTier[] tiers;
    Status  status;
}
```

### 3.2 Invoice reference

- A `bytes32` holding a UTF-8 string of **at most 32 bytes**, left-aligned and right-padded with zero bytes. This is the format `viem`'s `stringToHex(ref, { size: 32 })` produces, and `hexToString` decodes it.
- 32 **bytes**, not 32 characters. Non-ASCII characters take more than one byte each.
- Required: it must not be `bytes32(0)` → `EmptyInvoiceRef`.
- It is used unchanged as the memo on every transfer the escrow makes (§3.5).
- The contract does **not** enforce uniqueness, which saves a storage slot per invoice. The **frontend rejects** a reference the connected seller has already used (§4.3). A seller calling the factory directly can still reuse one.

### 3.3 Storage (InvoiceEscrow)

The packing below keeps the number of fresh slots per invoice small, since each new slot costs 250k gas on Tempo. Default payout and refund addresses are stored as `address(0)` and resolved when read, so the defaults cost no extra slot.

| Slot | Fields |
|---|---|
| 0 | `seller` (20 B) · `dueDate` (8 B) · `status` (1 B) · `initialized` (1 B) |
| 1 | `token` (20 B) |
| 2 | `invoiceRef` (32 B) |
| 3 | `principal` (16 B) |
| 4 | `payoutAddress` (20 B). Left zero if the seller gave none |
| 5 | `buyer` (20 B). Written by `fund` |
| 6 | `refundAddress` (20 B). Left zero if the buyer gave none |
| 7+ | `tiers` (length, plus elements: three `{uint64, uint16}` tiers fit in each slot) |

The exact layout is up to the implementer. The requirement is to minimise new slots.

Two internal helpers resolve the defaults:

- `_payout()` returns `payoutAddress`, or `seller` if it is zero.
- `_refund()` returns `refundAddress`, or `buyer` if it is zero.

### 3.4 InvoiceFactory

```solidity
address public immutable implementation;

constructor()   // deploys the implementation: implementation = address(new InvoiceEscrow())

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

The factory deploys the implementation itself, so the implementation's `factory` immutable (set to `msg.sender` in the `InvoiceEscrow` constructor) is the factory, with no circular deployment order.

`createInvoice`:
1. `invoice = Clones.clone(implementation)`
2. `InvoiceEscrow(invoice).initialize(msg.sender, invoiceRef, token, principal, dueDate, tiers, payoutAddress)`. The caller becomes the seller.
3. Emit `InvoiceCreated`, then return `invoice`.

`invoiceRef` is indexed, so an indexer or a later UI can find an invoice from its reference with `eth_getLogs`.

### 3.5 InvoiceEscrow functions

#### `initialize(address seller, bytes32 invoiceRef, address token, uint128 principal, uint64 dueDate, DiscountTier[] tiers, address payoutAddress)`

- Callable **once**, and **only by the factory** (`msg.sender == factory`, otherwise `NotFactory`). `factory` is an immutable set to `msg.sender` in the `InvoiceEscrow` constructor, which the factory runs when it deploys the implementation. The immutable lives in the implementation's bytecode, so clones see it through `delegatecall`. The constructor also marks the implementation initialised, so nobody can initialise the implementation itself.
- Validation:
  - not already initialised → `AlreadyInitialized`
  - `invoiceRef != 0` → `EmptyInvoiceRef`
  - `principal > 0` → `InvalidPrincipal`
  - `dueDate > block.timestamp` → `DueDateNotInFuture`
  - `tiers.length <= 10` → `TooManyTiers`
  - for each tier: `cutoff > previousCutoff` (strictly ascending; the first must be > 0) → `TiersNotAscending`; `cutoff <= dueDate` → `TierAfterDueDate`; `discountBps <= 10_000` → `DiscountTooLarge`
  - `StdPrecompiles.TIP20_FACTORY.isTIP20(token)` is true → `NotTIP20`. The precompile checks the fixed 12-byte TIP-20 prefix (`0x20C000000000000000000000`) **and** that the address has code, so an unused prefixed address is rejected.
- Stores `payoutAddress` only if it is non-zero and differs from `seller`.
- Sets `status = Active`.
- Zero tiers is allowed. The invoice then always pays the full principal.

#### `fund(address refundAddress)`

- Requires `status == Active` → `NotActive`.
- Requires `msg.sender != seller` → `SellerCannotFund`. This blocks the seller's own address. A seller could still fund from a second wallet, which the contract can't detect.
- `buyer = msg.sender`. Stores `refundAddress` only if it is non-zero and differs from `msg.sender`.
- Pulls `principal` from the buyer: `ITIP20(token).transferFromWithMemo(msg.sender, address(this), principal, invoiceRef)`.
- Sets `status = Funded` and emits `Funded(buyer, _refund(), principal)`.

#### `triggerPayment()`

- Requires `msg.sender == seller || msg.sender == buyer` → `NotParty`.
- Requires `status == Funded` → `NotFunded`.
- `bps = activeDiscount(block.timestamp)`
- `refund = principal * bps / 10_000`, rounded down. `toSeller = principal - refund`. Any rounding remainder goes to the seller.
- Sets `status = Paid` **before** the transfers (checks-effects-interactions).
- `transferWithMemo(_payout(), toSeller, invoiceRef)`. Then, if `refund > 0`, `transferWithMemo(_refund(), refund, invoiceRef)`.
- Emits `Paid(msg.sender, _payout(), toSeller, _refund(), refund, bps)`.

#### `cancel()`

- Authorised if `msg.sender == seller` (any time while Active or Funded), or if `msg.sender == buyer && block.timestamp > dueDate`. Before funding the buyer is `address(0)`, so on an unfunded invoice only the seller can cancel, including after the due date. Otherwise → `NotAuthorizedToCancel`.
- Requires `status == Active || status == Funded` → `AlreadySettled`.
- Sets `status = Cancelled`.
- If it was `Funded`: `transferWithMemo(_refund(), principal, invoiceRef)`.
- Emits `Cancelled(msg.sender, refunded)`, where `refunded` is `principal` or 0.

#### `getInvoice() view returns (InvoiceState)`

Returns the full state in one call, with no access restriction. `payoutAddress` and `refundAddress` are returned resolved: if none was given, they hold the seller's and buyer's addresses.

#### `activeDiscount(uint64 timestamp) view returns (uint16)`

Returns the `discountBps` of the first tier with `timestamp < cutoff`, or 0 if there is none. Tiers are sorted by cutoff, so the first future cutoff is the tier that applies. (The parameter is `timestamp` because `now` is a reserved word in Solidity.) It is public so the frontend and tests use the contract's own logic rather than reimplementing it.

### 3.6 Events (InvoiceEscrow)

```solidity
event Funded(address indexed buyer, address refundAddress, uint128 principal);
event Paid(address indexed caller, address payoutAddress, uint128 toSeller,
           address refundAddress, uint128 refundToBuyer, uint16 discountBps);
event Cancelled(address indexed caller, uint128 refunded);
```

The TIP-20 token also emits its own transfer-with-memo events carrying `invoiceRef`, so explorers and indexers can match every transfer to the invoice.

### 3.7 Lifecycle

```
createInvoice()         fund(refundAddress)     triggerPayment() / cancel()
     │                         │                          │
     ▼                         ▼                          ▼
  Active  ───────────────► Funded  ─────────────────► Paid / Cancelled

Seller may cancel: Active or Funded (any time before Paid, including an
                   unfunded invoice past its due date)
Buyer may cancel:  Funded, only when block.timestamp > dueDate
Seller may not fund their own invoice.
```

### 3.8 Worked example

The invoice is `INV-2026-0042`: 100,000.00 AlphaUSD, due in 60 days, with tiers of 15% until day 15 and 10% until day 30. The seller sets a treasury wallet as the payout address. The buyer funds with a separate refund wallet.

| Payment triggered on | To the seller's payout address | To the buyer's refund address |
|---|---|---|
| Day 5 | 85,000.00 | 15,000.00 |
| Day 20 | 90,000.00 | 10,000.00 |
| Day 45 | 100,000.00 | 0 |
| Cancelled after funding | 0 | 100,000.00 |

Every one of these transfers carries the memo `INV-2026-0042`.

### 3.9 TIP-20 risks to document (not to handle in code)

- **Pause / TIP-403 block:** if the issuer pauses the token, or blocks a party or a payout/refund address, then `fund`, `triggerPayment` and `cancel` revert. Funds stay in escrow until the block is lifted. There is no rescue path, which is acceptable for the PoC.
- **Receive policies:** a payout to an address with a restrictive receive policy *succeeds*, but the funds go to the `ReceivePolicyGuard` for that address to claim. The contract treats this as paid. Sellers and buyers should give addresses that accept the token.
- **TIP-20-prefixed recipients:** TIP-20 transfers revert for a recipient with the TIP-20 prefix (a token address). A payout or refund address like that makes `triggerPayment` or `cancel` revert, and the funds stay in escrow. Not checked in code.
- **`burnAt`:** an issuer holding `BURN_AT_ROLE` can burn escrowed funds. This is a trust assumption about the issuer.

---

## 4. Frontend

Location: `tempo/frontend/`. Stack: React + Vite + TypeScript + Tailwind + react-router, using **wagmi + viem** (`wagmi/tempo`, `viem/tempo`).

### 4.1 Configuration

- Chain: `tempoModerato` from `viem/chains` (chain ID `42431`).
- Connectors:
  - `tempoWallet({ feePayer: 'https://sponsor.moderato.tempo.xyz' })` from `wagmi/connectors` (connector id `xyz.tempo`). This is the primary, passkey-based wallet.
  - `injected()` as the fallback for MetaMask-style wallets.
- `.env`: `VITE_FACTORY_ADDRESS`, `VITE_FACTORY_DEPLOY_BLOCK` (the block to start log queries from, for the duplicate-reference check).
- Token list (hardcoded, testnet, all 6 decimals):

  | Token | Address |
  |---|---|
  | AlphaUSD (default) | `0x20c0000000000000000000000000000000000001` |
  | BetaUSD | `0x20c0000000000000000000000000000000000002` |
  | ThetaUSD | `0x20c0000000000000000000000000000000000003` |
  | pathUSD | `0x20c0000000000000000000000000000000000000` |
  | OUSD | `0x20c0000000000000000000006a37da5c996874be` |

### 4.2 Wallet capability matrix

| Capability | Tempo Wallet | Injected wallet |
|---|---|---|
| Sign in | Passkey | Extension key |
| Batched approve + fund | Yes, one `0x76` tx with `calls: [approve, fund(refundAddress)]` | No. Two txs: `approve`, then `fund` |
| Fee sponsorship | Yes: every write passes `feePayer: true` | No. The user pays fees in a stablecoin (fallback fee token is pathUSD) |

The UI checks the connected connector and picks the path. Users on an injected wallet see a short note that they need a stablecoin balance for fees.

### 4.3 Pages

| Route | Page | Behaviour |
|---|---|---|
| `/` | Home | Connect wallet (Tempo Wallet button plus an "other wallet" option). Hero, "Create Invoice" CTA, lookup by invoice address (`0x…`, validated with `isAddress`), and a three-step "How it works" (seller creates, buyer funds, either triggers payment) |
| `/create` | CreateInvoice | Fields: **invoice reference** (required; live byte counter, max 32 UTF-8 bytes; rejected if the connected seller has already used it, see below), amount, **token dropdown**, due date, discount tiers (add/remove, cutoff date + discount %, max 10), **payout address** (optional; placeholder "Your connected wallet"; validated with `isAddress`). Client-side validation mirrors §3.5. Submit calls `factory.createInvoice` (sponsored on Tempo Wallet). Reads the new address from the `InvoiceCreated` log in the receipt. Success screen shows the reference and offers copy-address and open-invoice buttons |
| `/invoice/:address` | InvoiceDetail | Shows the invoice reference prominently, plus seller, payout address, buyer and refund address (each marked "you" where it applies). Also the token symbol, principal, due date, status, and the tiers with the active one highlighted (via `activeDiscount`). Shows the current split between payout and refund |

**Duplicate-reference check (CreateInvoice):** before submitting, query the factory's `InvoiceCreated` logs filtered by `seller = connected address` and `invoiceRef = encodeRef(input)`. Both are indexed topics. Search from `VITE_FACTORY_DEPLOY_BLOCK` to `latest`, with `getLogs` in pages of **50,000 blocks** (the Moderato RPC rejects ranges over 100,000 blocks, and a full 100,000-block request returned a gateway error). If any log matches, block submission with "You already have an invoice with this reference" and link to the existing invoice. Run the check again immediately before sending, not only on input. The check is per seller: different sellers may use the same reference.

**Actions on InvoiceDetail:**

| Action | Shown when | Call |
|---|---|---|
| Fund | connected, not seller, `status == Active` | Optional **refund address** input (placeholder "Your connected wallet"). Tempo Wallet: batched `[token.approve(invoice, principal), invoice.fund(refundAddress)]`, sponsored. Injected: `approve` then `fund` |
| Trigger payment | `status == Funded` and the user is seller or buyer | `invoice.triggerPayment()` |
| Cancel | the user is seller (Active/Funded), or buyer with `now > dueDate` (Funded) | `invoice.cancel()` |

Before signing, the fund and pay actions show where money will go, for example: "15,000.00 AlphaUSD will be refunded to 0xAbc…".

Transaction handling: use the `*Sync` actions / `waitForTransactionReceipt`. Tempo finality is sub-second, so no polling loop is needed. Show a pending / success / error message for each action, then refetch `getInvoice` after each write.

### 4.4 Helpers

- `toUnits(amount) = parseUnits(amount, 6)` and `fromUnits(units) = formatUnits(units, 6)`. Read `decimals()` from the token rather than hardcoding it.
- `encodeRef(s) = stringToHex(s, { size: 32 })`. Reject it in the UI if `new TextEncoder().encode(s).length > 32`. Encode the reference exactly as the user typed it, apart from trimming leading and trailing whitespace, so the duplicate check and the on-chain memo match.
- `decodeRef(b) = hexToString(b, { size: 32 })`. This strips the zero padding.

---

## 5. Tests (Foundry)

| Test | Checks |
|---|---|
| `test_FullPaymentAtDueDate` | After the due date, the payout address gets 100% and the refund is 0 |
| `test_EarlyPaymentFirstTier` | In tier 1 (15%), payout gets 85% and refund gets 15% |
| `test_SecondTierAndBoundaries` | Payment exactly at a cutoff falls into the next tier (`now < cutoff` is strict) |
| `test_RoundingFavoursSeller` | Odd principal: the refund is floored and the seller gets the remainder |
| `test_CancelBeforeFundRefundsNothing` | No token movement, status Cancelled |
| `test_SellerCancelsUnfundedAfterDueDate` | Allowed |
| `test_CancelAfterFundRefundsBuyer` | The refund address gets the full principal |
| `test_BuyerCancelOnlyAfterDueDate` | Before the due date reverts; after it succeeds |
| `test_GetInvoiceReturnsState` | All fields match the inputs. Buyer and refund address are `address(0)` before funding |
| `test_PayoutDefaultsToSeller` | `payoutAddress = 0` → funds go to the seller, and `getInvoice` returns the seller |
| `test_CustomPayoutAddress` | Funds go to the payout address, not the seller |
| `test_RefundDefaultsToBuyer` | `fund(address(0))` → refund goes to the buyer |
| `test_CustomRefundAddress` | Discount refund and cancel refund both go to the refund address |
| `test_PayoutAndRefundAddressesCannotAct` | They can't call `triggerPayment` or `cancel` (`NotParty` / `NotAuthorizedToCancel`) |
| `test_SellerCannotFund` | `fund` from the seller reverts `SellerCannotFund` |
| `test_FundSetsBuyer_FundTwiceReverts` | |
| `test_TriggerPaymentOnlyParties` | A third party reverts `NotParty` |
| `test_CannotCancelOrPayAfterSettled` | |
| `test_FactorySetsSellerToCaller` | `seller == msg.sender`, `InvoiceCreated` emitted with `invoiceRef`, the clone address is returned |
| `test_InitializeOnlyOnceAndOnlyFactory` | Direct `initialize` on a clone or on the implementation reverts |
| `test_ValidationErrors` | Each custom error in §3.5, including `EmptyInvoiceRef` |
| `test_TransfersCarryInvoiceRefMemo` | The fund, pay, refund and cancel transfers all carry `invoiceRef` as the memo |

The tests need real TIP-20 behaviour, and the Tempo build of Foundry provides it locally (`network = "tempo"` in `foundry.toml`), so the unit suite runs with a plain `forge test` and no fork.

- **Unit tests (`test/unit/`)**: create a token with `StdPrecompiles.TIP20_FACTORY.createToken(...)`, grant the test contract `ISSUER_ROLE` through `ITIP20RolesAuth`, and `mint` to the actors. Memo checks use the real `TransferWithMemo` event.
- **Fork tests (`test/fork/`)**: run against Moderato with `--fork-url` for the live token set (AlphaUSD, OUSD, a non-TIP-20 address). `deal` does not work on TIP-20 balances; fund accounts with `vm.prank(holder)` and `transfer`.
- **Smoke tests (`test/smoke/`)**: the contract author's own minimal checks.

---

## 6. Project layout and commands

```
tempo/
  contracts/            # Foundry project (forge init -n tempo)
    src/InvoiceEscrow.sol
    src/InvoiceFactory.sol
    test/unit/          # local, real TIP-20 precompiles
    test/fork/          # forked Moderato
    test/smoke/
    script/Deploy.s.sol # deploys the factory (which deploys the implementation)
  frontend/             # Vite + React + wagmi
  docs/
    explainer/
    spec/invoice-discount-spec.md
```

- Build: `forge build`
- Test: `forge test -vvv` (unit and smoke, local). Fork suite: `TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz FOUNDRY_PROFILE=fork forge test -vvv`
- Frontend: `pnpm` (run through `corepack pnpm`, since the WSL `npm` is the Windows binary)
- Deploy (once per environment): `forge script script/Deploy.s.sol --rpc-url https://rpc.moderato.tempo.xyz --broadcast --verify --verifier-url https://contracts.tempo.xyz --tempo.fee-token 0x20c0000000000000000000000000000000000001`
- Testnet funds: `cast rpc tempo_fundAddress <ADDR> --rpc-url https://rpc.moderato.tempo.xyz`
- Explorer: https://explore.testnet.tempo.xyz

When this is scaffolded, update the root `CLAUDE.md` with these commands.

---

## 7. Out of scope

- Listing a user's invoices, or looking up an invoice by its reference in the UI. Lookup is by address. The indexed `InvoiceCreated` event makes both possible later.
- Changing the payout or refund address after it is set.
- Partial funding, partial payment, or changing terms after creation.
- Upgradeability, admin keys, and rescuing funds stuck by a token pause or block.
- Running our own fee-sponsor service. The PoC uses Tempo's public Moderato relay.
- Contract-level enforcement of unique invoice references. The frontend's check (§4.3) is enough for the PoC.
- Mainnet deployment, and Tempo Zones (privacy).
