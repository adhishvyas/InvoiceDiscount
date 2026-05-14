# InvoiceDiscount — Implementation Plan

---

## Prerequisites — Install These First

Run each command yourself in a terminal. Verify after each step.

### 1. Rust

```bash
# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Reload shell (or open a new terminal)
source "$HOME/.cargo/env"

# Verify
rustc --version    # expect: rustc 1.78 or newer
cargo --version
```

### 2. wasm32 compilation target (required for Soroban)

```bash
rustup target add wasm32-unknown-unknown

# Verify
rustup target list --installed | grep wasm32
```

### 3. Stellar CLI (includes Soroban contract tooling)

```bash
# Install via cargo (builds from source — takes a few minutes)
cargo install --locked stellar-cli --features opt

# Verify
stellar --version    # expect: stellar 21.x or newer
```

> **Alternative**: If you prefer a binary install, check https://github.com/stellar/stellar-cli/releases
> and download the Linux x86_64 binary, make it executable, and place it on your PATH.

### 4. Freighter Wallet (browser extension)

Install the Freighter wallet extension in Chrome or Firefox:
- Chrome: https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk
- After installing, create or import a wallet, then switch network to **Testnet**

### 5. Test PYUSD on Stellar Testnet

After setting up Freighter on Testnet:

1. Fund your testnet account with XLM (for gas) via the Stellar Friendbot:
   ```
   https://friendbot.stellar.org/?addr=YOUR_PUBLIC_KEY
   ```

2. Get testnet PYUSD from the Paxos faucet or Google Cloud Web3 faucet:
   - Paxos faucet: https://faucet.paxos.com
   - You need to add the PYUSD trustline in Freighter first (Asset code: `PYUSD`, Issuer: `GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G`)

### 6. Node.js

Already installed (v18.19.1). No action needed.

---

## Goals

Build a proof-of-concept invoice discounting dApp on Stellar Testnet using:
- Soroban smart contract (Rust) for trustless escrow + discount logic
- PYUSD (SAC) on Stellar Testnet as the payment token
- React + TypeScript frontend with Freighter wallet integration

---

## Phase 1: Soroban Contract

### Steps
1. Scaffold Cargo workspace + `invoice_discount` contract crate → verify: `cargo build`
2. Implement contract (`contracts/invoice_discount/src/lib.rs`) → verify: unit tests pass
3. Build WASM → verify: `.wasm` file produced
4. Deploy to Stellar Testnet → verify: contract ID returned, readable on testnet explorer

### Contract: `InvoiceDiscount`

**Storage keys:** `Seller | Buyer | Token | Principal | DueDate | Tiers | Status`

**Types:**
```rust
DiscountTier { cutoff: u64, discount_bps: u32 }  // cutoff = unix timestamp
Status: Active | Funded | Paid | Cancelled
```

**Functions:**

| Function | Auth | Description |
|---|---|---|
| `initialize(seller, buyer, token, principal, due_date, tiers)` | seller | Deploy & configure invoice |
| `fund()` | buyer | Lock `principal` PYUSD into contract |
| `trigger_payment(caller)` | buyer or seller | Compute discount, pay seller, refund remainder to buyer |
| `cancel(caller)` | seller (Active) or buyer (past due) | Refund buyer if funded, mark Cancelled |
| `get_invoice()` | none | Read-only: return all state |

**Discount selection in `trigger_payment`:**
```
tiers are stored ordered by cutoff ascending
for each tier:
    if now < tier.cutoff → use tier.discount_bps, break
if no tier matched → discount_bps = 0 (full payment)

payment_to_seller = principal - (principal * discount_bps / 10_000)
refund_to_buyer   = principal - payment_to_seller
```

**Validation in `initialize`:**
- `principal > 0`
- `due_date > now`
- tiers are ordered ascending by cutoff, all cutoffs ≤ due_date

---

## Phase 2: React Frontend

### Steps
1. Scaffold Vite + React + TypeScript app in `frontend/` → verify: dev server starts
2. Add Freighter wallet connection → verify: can connect wallet, read public key
3. Build contract client utility (wraps stellar-sdk calls) → verify: can call `get_invoice`
4. Build **Create Invoice** page (seller flow) → verify: deploys contract, shows contract ID
5. Build **Invoice Detail** page → verify: shows status, active discount tier, countdown
6. Build **Fund Invoice** flow (buyer, on Detail page) → verify: funds locked in contract
7. Build **Trigger Payment** flow (either party, on Detail page) → verify: funds disbursed
8. Add invoice list with local storage persistence → verify: invoices survive page refresh

### Stack
- `vite` + `react` + `typescript`
- `@stellar/stellar-sdk` — RPC calls, transaction building
- `@stellar/freighter-api` — wallet connection & signing
- `tailwindcss` — styling

### Pages / Routes
```
/                   Home / landing
/create             Create Invoice (seller)
/invoice/:id        Invoice Detail (fund, trigger, status)
```

### Contract Client (`frontend/src/utils/contract.ts`)
Wraps each contract function as a typed async call:
- `deployInvoice(params)` → contract address
- `fundInvoice(contractId)` → txHash
- `triggerPayment(contractId, caller)` → txHash
- `cancelInvoice(contractId, caller)` → txHash
- `getInvoice(contractId)` → InvoiceState

---

## Deploying the Contract

Run each command from the repo root (`InvoiceDiscount/`).

### 1. Build and optimize the WASM

```bash
cd contracts/invoice_discount
stellar contract build --optimize
```

Output: `../../target/wasm32-unknown-unknown/release/invoice_discount.optimized.wasm`

### 2. Upload the WASM to testnet

```bash
stellar contract upload \
  --network testnet \
  --source <your-secret-key-or-identity> \
  --wasm target/wasm32-unknown-unknown/release/invoice_discount.optimized.wasm
```

This prints the WASM hash. Save it — you need it in the next step.

### 3. Update the frontend env

In `frontend/.env` (create it if it doesn't exist):

```
VITE_WASM_HASH=<hash-from-step-2>
```

The frontend uses this hash to instantiate a new contract when creating an invoice. Each time the contract code changes, repeat steps 1–3 and update this value.

---

## Phase 3: Polish & Testing

1. End-to-end test: create → fund → trigger (early, mid, late tier)
2. Edge cases: cancel before fund, cancel after fund, trigger after due date
3. Error states in UI: wrong wallet, insufficient balance, already paid

---

## Network Config

| | Value |
|---|---|
| Network | Stellar Testnet |
| RPC URL | `https://soroban-testnet.stellar.org` |
| Horizon URL | `https://horizon-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |
| PYUSD testnet issuer | `GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G` |
| PYUSD asset code | `PYUSD` |

---

## Project Structure

```
InvoiceDiscount/
├── claude-plans/
│   └── implementation.md
├── contracts/
│   └── invoice_discount/
│       ├── src/
│       │   └── lib.rs
│       └── Cargo.toml
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── utils/
│   │       └── contract.ts
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── Cargo.toml          (workspace)
└── CLAUDE.md
```
