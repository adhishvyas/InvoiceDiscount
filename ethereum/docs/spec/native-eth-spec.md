# InvoiceDiscount on Ethereum: Native ETH Invoices

> Status: approved 2026-11-03; interface frozen at tag `ethereum-interface-v2`. Extends the port ([`invoice-discount-spec.md`](invoice-discount-spec.md), the "port spec") and Pay with Mesh ([`mesh-pay-now-spec.md`](mesh-pay-now-spec.md), the "Mesh spec"). Plan: [`../plan/native-eth-dag.md`](../plan/native-eth-dag.md). Design choices marked *(user)* were made by the user on 2026-11-03.

---

## 1. Goal

Let a seller issue an invoice payable in **native ETH**, alongside the ERC-20 stablecoins (PYUSD, USDG, USDC). An ETH invoice supports every path an ERC-20 invoice has: fund → trigger, cancel, direct payment → `settleDirect()`, and Pay with Mesh.

Pay with Mesh matters most here. Mesh's sandbox supports Sepolia wallet transfers in **native ETH only** (Mesh spec §6.2). So an ETH invoice is the one way to run the whole Mesh path (Link → transfer → webhook → `settleDirect()` → Paid) on Sepolia today.

---

## 2. Design decisions

| Topic | Decision | Why |
|---|---|---|
| Representation | **`token == address(0)` means native ETH** *(user)*. No new field; `InvoiceState.token`, `InvoiceCreated.token` and every signature keep their types | Smallest ABI change. `address(0)` can't be an ERC-20 (the port already rejects it with `InvalidToken`) |
| Funding | `fund(refundAddress)` becomes **`payable`**. ETH invoice: `msg.value` must equal `principal`. ERC-20 invoice: `msg.value` must be 0 | One entry point for both. A wrong value is rejected rather than kept |
| Payouts | **Push, then pull** *(user)*. Each ETH payout is sent with a gas cap; if the recipient rejects it, the amount is **credited** to them and they withdraw it later | Nobody can block the other party: a buyer whose refund address rejects ETH can't freeze `triggerPayment` or `cancel`, and a payout address can't freeze settlement |
| Direct payments | **`receive()` accepts ETH only while the invoice is Active** *(user)*, and emits an event | A late or second payment (for example a Mesh transfer after someone else settled) is refused, so it stays with the payer instead of being stuck in the clone. The event gives the history view a log, since plain ETH transfers leave none |
| ERC-20 path | **Unchanged in behaviour** | Every existing ERC-20 rule, error and event holds |
| Token list | **ETH, PYUSD, USDG, USDC** *(user)*. Pay with Mesh for ETH, PYUSD and USDG; USDC keeps fund/trigger and direct payment only | |
| Deployment | **New factory and implementation**, interface tag `ethereum-interface-v2`. The frontend and mesh-server point at the new factory only | Clones delegate to a fixed implementation, so existing invoices can't gain ETH support. Invoices on the old factory keep working on-chain but are no longer listed (as Tempo's MPP change did) |

---

## 3. Contract changes

`NATIVE = address(0)`. Only the parts that change are listed; everything else in port spec §3 stands.

### 3.1 `initialize` (via `createInvoice`)

Check 8 becomes: `token != address(0) && token.code.length == 0` → `InvalidToken`. `address(0)` is accepted and means ETH. Check order and every other check are unchanged.

### 3.2 `fund(address refundAddress) payable`

Checks, in order:
1. `status != Active` → `NotActive`
2. `msg.sender == seller` → `SellerCannotFund`
3. ETH invoice and `msg.value != principal`, or ERC-20 invoice and `msg.value != 0` → **`IncorrectValue(uint256 sent, uint256 expected)`** (`expected` is `principal` or 0)

Effects are unchanged and come before any interaction. ERC-20: the same `safeTransferFrom`. ETH: no interaction, since the value arrived with the call. `Funded` is emitted as before.

### 3.3 Sending ETH: `_send(to, amount)`

Used by `triggerPayment`, `cancel` and `settleDirect` whenever the invoice is ETH (ERC-20 keeps `safeTransfer`):

- `amount == 0` → nothing is sent and no event is emitted. For ERC-20 the port's "always send `toSeller`, even 0" rule stays.
- Otherwise, a call to `to` with `value: amount`, a **gas cap of `PUSH_GAS = 50_000`**, empty calldata, and **no copying of return data** (assembly `call`, out size 0), so a recipient can neither burn the caller's gas nor return-bomb it.
- If the call fails, the transaction **doesn't revert**: `owed[to] += amount` and `PayoutDeferred(to, invoiceRef, amount)` is emitted.

The escrow's own events (`Paid`, `Cancelled`, `SettledDirect`) are unchanged and report the amounts as before, whether they were pushed or deferred.

### 3.4 `withdraw(address to)`

Sends the caller's credited ETH to `to` (the caller's own address, or another one, for a contract that can't receive ETH).

- `owed[msg.sender] == 0` → **`NothingToWithdraw`**.
- Effects: `owed[msg.sender] = 0`, before the call.
- Interaction: a call to `to` with the full amount and **all remaining gas** (the caller chose `to`). If it fails → **`WithdrawFailed`**, and the whole call reverts, so the credit is restored.
- Emits **`Withdrawn(msg.sender, to, amount)`**.
- Works in any status, including on an ERC-20 invoice, where `owed` is always 0.

### 3.5 `receive() payable`

- ERC-20 invoice → **`NativeNotAccepted`**.
- ETH invoice with `status != Active` → `NotActive`.
- Otherwise the ETH is accepted and **`Received(from, invoiceRef, amount)`** is emitted.

`receive()` reads storage and emits an event, so it needs more than the 2,300-gas stipend of Solidity's `transfer`/`send`. Wallets and exchanges send plain transactions with full gas, so this only affects other contracts that use `transfer`. ETH forced in without a call (`selfdestruct`, block rewards) bypasses `receive()`; it simply counts towards `settleDirect`'s balance.

### 3.6 `settleDirect()`

`balance` is `address(this).balance` for an ETH invoice (`IERC20.balanceOf` for ERC-20). The checks, the effects and the "whole balance to the payout address" rule are unchanged; the forward goes through `_send`.

Credited amounts (§3.3) only arise once an invoice is Paid or Cancelled, so they never count towards an Active invoice's balance.

### 3.7 `triggerPayment()` and `cancel()`

Unchanged, except that for an ETH invoice the transfers go through `_send`.

### 3.8 New view and storage

- `owed(address account) external view returns (uint256)`.
- Storage: one new slot (8) for the `owed` mapping. The NatSpec layout comment is updated, and the "must not use more fresh slots" rule moves to the v2 layout.

### 3.8a The implementation contract

The implementation's own storage has `token == address(0)` and status Active, so without a guard it would look like an Active ETH invoice (its `fund` would succeed with `msg.value == 0`, and `receive()` would accept ETH). Its constructor therefore also sets **status `Cancelled`**: `fund`, `receive()`, `triggerPayment` and `settleDirect` on it revert with their status errors. Clones are unaffected (their storage is their own). *(Added at the C1 freeze.)*

### 3.9 Summary of ABI changes (`ethereum-interface-v1` → `-v2`)

| Kind | Added or changed |
|---|---|
| Function | `fund` becomes `payable`; `withdraw(address)`; `owed(address)`; `receive()` |
| Error | `IncorrectValue(uint256,uint256)`, `NothingToWithdraw()`, `WithdrawFailed()`, `NativeNotAccepted()` |
| Event | `Received(address indexed from, bytes32 indexed invoiceRef, uint256 amount)`, `PayoutDeferred(address indexed to, bytes32 indexed invoiceRef, uint256 amount)`, `Withdrawn(address indexed account, address to, uint256 amount)` |
| Factory | NatSpec only (`token` may be `address(0)`) |

### 3.10 Reentrancy

Checks-effects-interactions holds on every path: status (and `owed`) are written before any ETH leaves. A recipient that re-enters during a push finds the status already final and hits that function's status error. Re-entering `withdraw` finds its credit already zeroed. Push calls are also capped at 50,000 gas. There is still no reentrancy guard (port spec §3.5).

### 3.11 Risks

- **Stray ETH:** ETH that arrives while Active and is then overtaken by `fund()` stays in the clone, as port spec §3.9 describes for tokens. `receive()` refusing non-Active invoices removes the common case (a late Mesh payment).
- **Smart-contract wallets that need more than 50,000 gas** to receive ETH get a credit instead of the transfer, and withdraw it themselves.
- **Mesh fees:** if Mesh delivers less than the quoted ETH, the existing balance check refuses to settle (Mesh spec §2, Fees).

---

## 4. Frontend changes

- **Config:** `TOKENS` gains `{ symbol: 'ETH', address: 0x000…000 }`. `MESH_TOKENS` gains ETH. ETH uses 18 decimals and its symbol from config; there's no `decimals()` or `symbol()` call.
- **`src/lib/`** (frozen interface, so a new tag `ethereum-frontend-interface-v4`):
  - `tokens.ts` (new): `NATIVE_TOKEN`, `isNative(token)`, `NATIVE_DECIMALS = 18`.
  - `fundPath`: for an ETH invoice the path is **`'native'`**, one `fund{value: principal}` transaction with no approve, whatever the wallet's capabilities.
  - `actions`: `ActionContext` gains `owed` (the connected account's credit) and `VisibleActions` gains **`withdraw`** (connected and `owed > 0`, in any status). For an ETH invoice, `cloneBalance` is the clone's ETH balance.
  - `history`: inbound direct payments for an ETH invoice come from `Received` events (not ERC-20 `Transfer` logs). `PayoutDeferred` and `Withdrawn` appear in the timeline.
- **Pages:** the create form offers ETH. The invoice page reads the ETH balance with `getBalance` and shows amounts in ETH. Fund sends `value` with a single transaction. Add a **Withdraw** action ("You have X ETH to withdraw from this invoice") that sends to the connected account.

---

## 5. mesh-server changes

- `tokenBalance(client, token, holder)`: for `address(0)`, `getBalance(holder)`. Its signature is unchanged.
- New `tokenDecimals(client, token)`: 18 for `address(0)`, else ERC-20 `decimals()`. Used by `POST …/mesh-session`.
- `MESH_TOKENS` accepts `ETH:0x0000000000000000000000000000000000000000`.
- Mesh session: `symbol: "ETH"`, `networkCaip2: eip155:11155111`, `amount` = `formatUnits(amount, 18)`.

This changes documented behaviour, so it gets a new tag, `ethereum-mesh-server-interface-v3`.

---

## 6. Tests

- **Contract unit tests** (Sonnet agent, black-box):
  - ETH lifecycle: create, fund with value, trigger with a discount, cancel funded and unfunded, `settleDirect`.
  - `IncorrectValue` for every wrong-value case on both invoice kinds.
  - `receive()` rules and the `Received` event.
  - Push succeeding, and a recipient that **rejects** ETH, **burns all gas** or **return-bombs** getting a credit while the call still succeeds.
  - Reentrant recipients on each path.
  - `withdraw`: success, to another address, `NothingToWithdraw`, `WithdrawFailed` restoring the credit, a reentrant withdraw.
  - Zero-amount ETH sends skipped.
  - Every ERC-20 test still passing unchanged.
- **Fork test:** an ETH lifecycle on a Sepolia fork, and `createInvoice` gas with ETH.
- **Frontend unit tests:** `isNative`, `fundPath` with `native`, `withdraw` in `visibleActions`, history with `Received` / `PayoutDeferred` / `Withdrawn`, the token list.
- **Server unit tests:** `tokenBalance` and `tokenDecimals` for ETH; a `mesh-session` for an ETH invoice (symbol `ETH`, 18-decimal amount string); a `completed` webhook on an ETH invoice settling from the ETH balance.
- **End-to-end (Sepolia):**
  - An ETH invoice paid through Mesh Link from MetaMask: Link → transfer → `transfer.completed` → `settleDirect` → Paid.
  - Fund/trigger and cancel in ETH.
  - A Withdraw after a payout to a contract that rejects ETH.
  - One PYUSD regression run.

---

## 7. Out of scope

WETH or wrapping; ETH on other chains; a reentrancy guard; rescuing stray ETH; migrating invoices from the old factory.
