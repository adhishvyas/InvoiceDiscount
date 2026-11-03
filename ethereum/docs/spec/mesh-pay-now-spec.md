# InvoiceDiscount on Ethereum: Pay Now via Mesh

> Status: draft, October 2026. Not yet planned or implemented. This spec assumes an Ethereum port of InvoiceDiscount exists (§3). It reuses the Pay now design from the Tempo MPP spec ([`../../../tempo/docs/spec/mpp-pay-now-spec.md`](../../../tempo/docs/spec/mpp-pay-now-spec.md), the "MPP spec"), but swaps MPP for Mesh as the way the money arrives. How Mesh works is covered in [`../explainer/mesh-how-it-works.md`](../explainer/mesh-how-it-works.md).

---

## 1. Goal

Let a buyer pay an Active invoice **from any exchange account or wallet Mesh supports** (Coinbase, Binance, MetaMask, Rainbow and others), not only from a wallet connected to our app. The buyer pays the discounted amount that applies right now, and the invoice settles in one step.

The flow:

1. The buyer clicks **Pay with Mesh** on an Active invoice.
2. Our new **mesh-server** checks the invoice, works out the amount due now, and asks Mesh for a **Link Token**: a one-time session that pays exactly that amount, in the invoice's token, on Ethereum, to the **invoice clone's address**.
3. The frontend opens **Mesh Link** (Mesh's hosted modal) with the token. The buyer connects an exchange or wallet and approves the transfer inside Link.
4. Mesh moves the funds into the clone and sends mesh-server a signed **webhook** when the transfer succeeds.
5. mesh-server checks on-chain that the clone holds enough, then calls the permissionless **`settleDirect()`**. The invoice becomes Paid and the funds go to the seller's payout address.

The existing fund → trigger path stays. Whichever path settles an Active invoice first wins.

---

## 2. Design decisions

| Topic | Decision | Why |
|---|---|---|
| Chain | **Ethereum**, with **Sepolia** for development | Mesh's sandbox has no Tempo testnet. Sepolia is a sandbox testnet with real on-chain wallet transfers |
| Invoice path | **Pay now via `settleDirect()`** (MPP spec §3.1), unchanged | A Mesh transfer is a plain token transfer, so it can't call `fund()`, which pulls tokens with `transferFrom`. `settleDirect()` already settles from the clone's balance |
| Who is paid | The **invoice clone** is the Mesh `toAddress`. It forwards the funds to the payout address in `settleDirect()` | Keeps the contract the source of truth for status. Each invoice has its own address, so Mesh's transfer is attributed to the invoice without a memo |
| Mesh transfer type | **`payment`**, with one fixed `amount` and one destination | `payment` is Mesh's fixed-amount flow. A `deposit` lets the user pick the amount, which invites underpayment |
| Fees | `isInclusiveFeeEnabled: false` | Mesh fees are added on top, so the clone receives the full quoted amount |
| Tokens | Only invoices whose token Mesh supports on the target network. On Sepolia: **PYUSD** and **USDG** | Mesh can only deliver its listed token/network pairs. Pay with Mesh is hidden for other tokens |
| Sources of funds | **Mesh Link** with exchanges and wallets, including the manual QR/copy-paste fallback Link offers by default | What "any wallet" means in this PoC. Cross-chain bridging is out of scope (§8) |
| Pricing | Same idea as MPP spec §4.2: the **smallest discount that applies at any moment in the quote window** | The payment must still cover the amount due when `settleDirect()` runs. The window here is longer (§4.2) |
| Confirmation | The **webhook is a trigger, the chain is the truth.** mesh-server settles only after checking the clone's on-chain balance | Webhooks can be retried, delayed or (in sandbox) describe simulated transfers. A false `Succeeded` must never cause a bad settlement. `settleDirect()` enforces the amount anyway |
| Gas for `settleDirect()` | Paid in Sepolia ETH by the mesh-server **settler key** | Ethereum has no fee sponsorship. The key has no special rights in the contract |
| Gas for the payer | Handled inside Mesh Link: exchanges pay their own withdrawal fees; wallet users pay ETH gas from their own wallet | The buyer doesn't need a wallet connected to our app |
| Server | New **`ethereum/mesh-server/`** service | User decision. It holds the Mesh API secret, the webhook secret and the settler key |
| Buyer identity | Not recorded on-chain. The payer's source and refund address come from the webhook and are shown off-chain | Same position as the MPP spec: a permissionless `settleDirect()` can't prove who paid |

---

## 3. Ethereum port: differences that affect Mesh

The port itself is specified in [`invoice-discount-spec.md`](invoice-discount-spec.md) and implemented on Sepolia. It keeps the Tempo contract's interface, including `settleDirect()`, `getInvoice()` and `activeDiscount()`. These Tempo → Ethereum differences matter for Mesh:

| Tempo | Ethereum | Effect on this spec |
|---|---|---|
| TIP-20 `transferWithMemo` puts `invoiceRef` on every escrow transfer | ERC-20 has no memo | The forward transfer in `settleDirect()` can't carry `invoiceRef`. Reconciliation instead uses the `SettledDirect` event (which includes `invoiceRef`), plus the `transactionId` we give Mesh (§4.3) |
| Gas paid in a stablecoin, sponsored by the app | Gas paid in ETH, no sponsorship | The settler key needs Sepolia ETH. Buyers who pay from a wallet need ETH for gas |
| Tempo Wallet (passkeys) as the primary connector | Injected wallets (MetaMask etc.) | Only the seller needs to connect to our app. The buyer connects inside Mesh Link |
| Any TIP-20, all with 6 decimals | Any ERC-20; decimals vary | The quote must use the token's own `decimals()`. PYUSD and USDG both use 6 |
| TIP-20 pause/blocklist risks | PYUSD and USDG are issuer-controlled and can also pause or block addresses | Same risk as MPP spec §7, for the forward transfer |
| `isTIP20` check at invoice creation | No equivalent registry; the port checks only that the token address has code (`InvalidToken`) | None. The frontend's token list limits sellers to PYUSD, USDG and USDC |

---

## 4. mesh-server (`ethereum/mesh-server/`)

### 4.1 Responsibilities

1. **Start a payment:** validate the invoice, quote it, and return a Link Token to the frontend.
2. **Receive webhooks:** verify each one, and settle the invoice when the funds are confirmed on-chain.
3. **Report status:** let the frontend poll a payment's progress after Link closes.

It needs these secrets and settings (exact names go in the plan): the Mesh Client ID and API key, the Mesh environment (sandbox or production base URL), the webhook secret, the settler private key, the factory address, an Ethereum RPC URL, and the frontend origin for CORS.

### 4.2 Quote

As in MPP spec §4.2, with a longer window:

- **Window start:** the latest block timestamp `t`.
- **Window length:** the Link Token's 10-minute lifetime plus an allowance for the transfer to land on-chain. Wallet transfers land within a few blocks. Exchange withdrawals can take much longer, and Mesh says exchanges may take "seconds to days" to post. The plan picks the allowance. A payment that lands after the window may be short (§7).
- **Discount:** the smallest `activeDiscount` value at any instant in the window, found by calling the contract at `t` and at each tier cutoff inside the window.
- **Amount:** `principal − floor(principal × quoteBps / 10_000)`, converted to the token's display units for Mesh.

### 4.3 Endpoints

**`POST /invoices/:address/mesh-session`** (called by the frontend)

1. `address` must be a clone of the configured factory's implementation → otherwise `404`. This stops a crafted URL from sending a payment to an arbitrary contract.
2. `getInvoice()`: status must be `Active` → otherwise `409`.
3. The invoice token must be a token Mesh supports on the target network → otherwise `422`.
4. The clone's balance must be below the amount due now. Otherwise the invoice only needs settling, and the frontend offers Finish settlement (MPP spec §5.1) instead.
5. Compute the quote (§4.2).
6. Request a Link Token from Mesh (`POST /api/v1/linktoken`) with:
   - `transferType: "payment"`, `isInclusiveFeeEnabled: false`
   - one `toAddresses` entry: the target network's Mesh `networkId`, the token symbol, the clone address, and the quoted `amount`
   - a `transactionId` that encodes the invoice and this session, so webhooks map back to it
   - a `userId` for the buyer that isn't personal data
7. Record the session (invoice, quote, `transactionId`, expiry) and return the Link Token, amount, discount and expiry to the frontend.

**`POST /webhooks/mesh`** (called by Mesh)

1. Verify the `X-Mesh-Signature-256` HMAC over the raw body. Reject it if it doesn't match.
2. Return `200` straight away (Mesh's limit is 200 ms) and process the event in the background.
3. Ignore any event whose `EventId` has already been processed.
4. Map `TransactionId` to its session. Check that `DestinationAddress`, `Chain` and `Token` match the session.
5. On `Succeeded`: read the clone's on-chain token balance. If the invoice is still Active and the balance covers the amount due now, call `settleDirect()` and record the result. Otherwise record why it didn't settle.
6. On `Failed`: mark the session failed. The buyer can start again.

**`GET /invoices/:address/mesh-session/:id`** (called by the frontend)

Returns the session's state: `awaiting-transfer`, `pending`, `succeeded`, `settled` (with the `settleDirect` tx hash), `failed`, or `needs-attention` (funds arrived but settling didn't happen, with the reason). It also returns the payer details from the webhook: source provider, source address and refund address.

### 4.4 Local development

Mesh has to be able to reach the webhook URL over the public internet. In local development that means a tunnel. Mesh allows **one sandbox webhook URL** per account, sends from a fixed IP (`20.22.113.37`), and only renders Link on domains on the dashboard's **Allowed domains** list, which must include the frontend's dev origin.

---

## 5. Frontend changes

| Action | Shown when | Behaviour |
|---|---|---|
| **Pay with Mesh** | `status == Active`, the token is Mesh-supported, the clone's balance is below the amount due now, and the viewer isn't the seller. **No wallet connection is required** | 1. Call `mesh-session`. 2. Show "Pay **X PYUSD** now (Y% discount) to invoice `INV-…`. Quote valid until hh:mm:ss." 3. On confirm, open Mesh Link with the Link Token. 4. On `onTransferFinished`, show "Payment submitted", then poll the session status until it is settled, failed or needs attention |
| **Finish settlement** | As in MPP spec §5.1 | Unchanged. It's the fallback if mesh-server didn't settle |
| **Accept and settle** | As in MPP spec §5.1 | Unchanged. It's the seller's fallback for a short payment (§7) |

The Link SDK callbacks drive the UI only. A payment counts as done when the session reaches `settled`, or when the invoice status reads Paid on-chain.

Invoice history shows the inbound transfer into the clone, the `SettledDirect` event, and the Mesh payer details from the session.

---

## 6. Prerequisites and testing

### 6.1 Before building

- A **Mesh dashboard account**. It's invite-only, through a Mesh representative.
- A **sandbox API key** with Read & Write permissions, an Allowed-domains entry for the dev origin, and a registered sandbox webhook URL.
- Confirm that the **PYUSD and USDG token contracts Mesh uses on Sepolia** are the ones our test invoices are created with, along with their decimals.
- The Mesh **`networkId` for Sepolia**, from `GET /api/v1/transfers/managed/networks`.

### 6.2 What the sandbox can and can't prove

- **Wallet flows** (MetaMask or Rainbow on Sepolia) make **real on-chain testnet transfers**. They are the only way to test the whole path, from Link to the webhook to `settleDirect()` to Paid.
- **Exchange flows** (the simulated Coinbase and Binance test accounts) move **no real assets**. They test the Link UX and webhook handling. The on-chain check (§4.3 step 5) should then refuse to settle, and that refusal is itself a useful test.
- The `Pending` webhook isn't guaranteed in sandbox, so no logic may depend on it.

### 6.3 Tests

- **Server unit tests:** the quote window (including tier cutoffs and the due date); clone validation; HMAC verification against the raw body; deduplication by `EventId`; a `Succeeded` event with an insufficient balance not settling; a webhook for an already-Paid invoice.
- **End-to-end (manual, Sepolia):** create a PYUSD invoice, then pay it through Mesh Link from MetaMask on Sepolia. Confirm the transfer into the clone, the `Succeeded` webhook, the `settleDirect` transaction, the payout and the Paid status.

---

## 7. Risks (documented, not handled in code)

- **Late arrival and a short payment:** if an exchange posts the transfer after the quote window and a tier cutoff has passed, the amount due goes up, and `settleDirect()` reverts for anyone except the seller. The seller can use Accept and settle. mesh-server reports `needs-attention`.
- **Payment into a non-Active clone:** this happens on a race with `fund`, on a second Mesh payment, or when the seller cancels while a transfer is in flight. The funds stay in the clone, and there's no rescue path (MPP spec §7). Mesh returns a `RefundAddress` that a future rescue feature could use.
- **Manual (QR) deposits** let the buyer send any amount from any wallet. An underpayment is handled as above. An overpayment goes to the seller, because `settleDirect()` forwards the whole balance.
- **Server trust:** mesh-server can't redirect funds, because the destination is the verified clone. It can fail to settle, but anyone can call `settleDirect()`.
- **Mesh as a dependency:** if Mesh is down or the webhook is lost, the funds still reach the clone, and Finish settlement covers the gap.

---

## 8. Out of scope

- **Cross-chain bridging** (for example USDC on Solana → Ethereum). Mesh bridges into Ethereum, but only on mainnet, and headless bridging has to be enabled per client.
- Mainnet and production Mesh keys.
- Escrow funding (the Funded state) through Mesh.
- Mesh Managed Tokens (return-user one-tap), Paylinks, onramp (buying crypto with fiat), and the mobile SDKs.
- Recording the payer on-chain, and refunds through Mesh's `RefundAddress`.
- The Ethereum port itself (§3).
