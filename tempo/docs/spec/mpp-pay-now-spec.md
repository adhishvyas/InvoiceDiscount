# InvoiceDiscount on Tempo: Pay Now via MPP

> Status: draft, October 2026. Extends [`invoice-discount-spec.md`](invoice-discount-spec.md) (the "base spec"). Section references like "base §3.5" point there.

---

## 1. Goal

The base spec settles an invoice in two steps: a buyer **funds** the escrow with the full principal, then a party **triggers payment** and the discount is refunded. This spec adds a second, one-step path: a buyer **pays an Active invoice instantly over HTTP using MPP** (the Machine Payments Protocol) and pays only the discounted amount that applies right now.

Seen as an MPP flow:

1. The buyer asks the MPP server to pay invoice `0x…`.
2. The server replies **`402 Payment Required`** with a **Challenge**. The Challenge's `amount` is the principal less the current discount, its `currency` is the invoice's token, and its `recipient` is the invoice clone.
3. The buyer's wallet broadcasts a sponsored TIP-20 transfer into the clone and retries the request with its tx hash as a **Credential** ("push" mode, see §2).
4. The server checks the transfer on-chain, then calls `settleDirect()` on the invoice. That call marks the invoice Paid and forwards the funds to the seller's payout address, with the invoice reference as the memo.
5. The server returns **`200 OK`** with a **Receipt**.

The main point of the PoC is to learn MPP. The UI therefore shows the Challenge before payment and the Receipt after it (§5.2).

The existing fund → trigger path stays. An Active invoice can be settled either way, and whichever happens first wins.

---

## 2. Design decisions

| Topic | Decision | Why |
|---|---|---|
| MPP intent | `charge` with the Tempo method (`tempo.charge` from `mppx`) | One request, one payment, a fixed amount: the definition of `charge`. `session` is for metered usage |
| Who is paid | The **invoice clone** is the Challenge `recipient`. The clone then forwards the funds to the payout address in `settleDirect()` | A Tempo MPP charge is a plain TIP-20 transfer and can't call a contract. Paying into the clone keeps the contract the source of truth for the invoice's status |
| Marking it paid | New **permissionless** `settleDirect()` on `InvoiceEscrow`. It checks that the clone's token balance covers the discounted amount due now | No trusted server key in the contract. If the server's call fails, anyone (including the frontend) can retry it |
| Memo | The buyer's transfer carries the **MPP attribution memo** (set by `mppx`, bound to the Challenge). The forward transfer from the clone carries `invoiceRef` | Tempo MPP doesn't support custom top-level memos. The forward transfer restores reconciliation by invoice reference |
| Pricing | Challenge amount = principal − discount, using the **smallest discount that applies at any moment in the quote window** (§4.2) | Ensures the payment still covers the amount due if a tier cutoff passes before `settleDirect()` runs |
| Challenge expiry | 2 minutes | A short window keeps the quote close to the live tier |
| Credential mode | **Push**: the wallet broadcasts the transfer and the Credential carries its tx hash | The `mppx` client picks push for wallet (`json-rpc`) accounts. The server never holds a signed payer transaction |
| Gas for the payer | **Sponsored by the wallet**: the Tempo Wallet connector's existing `feePayer: 'https://sponsor.moderato.tempo.xyz'` applies to the transfer the wallet sends. The server sets no `feePayer` | Matches base §2. The buyer needs only the invoice token |
| Gas for `settleDirect()` | Paid by the server's **settler key**, which holds testnet stablecoin for fees | A server-side write. The key has no special rights in the contract |
| Client | **Browser only**: a "Pay now via MPP" button on InvoiceDetail, Tempo Wallet only | User decision. Injected wallets are out of scope (§8) |
| Server | New `tempo/mpp-server/`: a small Node HTTP server using `mppx/server` and `viem` | MPP is HTTP-native and needs something to issue 402s. Today the app has no backend |
| Coexistence | `settleDirect()` requires `status == Active`. `fund` is unchanged | Whichever path settles first wins. The other then reverts (`NotActive`) or is refused by the server (409) |

---

## 3. Contract changes (`InvoiceEscrow`)

### 3.1 New function: `settleDirect()`

```solidity
function settleDirect() external;
```

- Requires `status == Active` → `NotActive`.
- `bps = _activeDiscount(uint64(block.timestamp))`.
- `due = principal - principal * bps / 10_000`. This is the `toSeller` amount from base §3.5, with the same rounding: the discount is floored and the seller gets the remainder.
- `balance = ITIP20(token).balanceOf(address(this))`.
- Requires `balance > 0` → `NothingToSettle`.
- If `msg.sender != seller`: requires `balance >= due` → `InsufficientDirectPayment(balance, due)`.
  - **Seller override:** the seller may settle for less than `due`. This lets a seller accept an underpayment rather than leave funds stuck in the clone (§7). Only the seller loses from this, so only the seller may do it.
- Sets `status = Paid` before the transfer (checks-effects-interactions).
- `transferWithMemo(_payout(), balance, invoiceRef)`. The **whole balance** is forwarded, so any overpayment (§4.2) goes to the seller.
- Emits `SettledDirect(msg.sender, _payout(), balance, bps)`.

`buyer` and `refundAddress` stay `address(0)`. The payer is identified off-chain: it is the `from` of the inbound transfer and appears in the MPP Receipt. A permissionless caller could pass in any address, so the contract has no trustworthy way to record the payer.

### 3.2 New errors and event

```solidity
error NothingToSettle();
error InsufficientDirectPayment(uint256 balance, uint256 due);

event SettledDirect(address indexed caller, address payoutAddress, uint256 amount, uint16 discountBps);
```

### 3.3 Lifecycle (updated)

```
createInvoice()       fund(refundAddress)       triggerPayment() / cancel()
     │                       │                            │
     ▼                       ▼                            ▼
  Active ────────────────► Funded ───────────────────► Paid / Cancelled
     │
     │  MPP transfer into clone, then settleDirect()
     └──────────────────────────────────────────────────► Paid
```

### 3.4 Unchanged

`fund`, `triggerPayment`, `cancel`, `getInvoice` and `activeDiscount` don't change. Storage layout doesn't change: `settleDirect` uses no new slots.

### 3.5 Deployment

The implementation's bytecode changes, so this needs a **new factory deployment** (base §6). Invoices created by the old factory don't have `settleDirect()`. The MPP server only serves invoices from the factory it is configured with (§4.1), and the frontend's `VITE_FACTORY_ADDRESS` must point at the same new factory.

---

## 4. MPP server (`tempo/mpp-server/`)

### 4.1 Configuration

| Env var | Purpose |
|---|---|
| `MPP_SECRET_KEY` | Secret `mppx` uses to bind Challenges, so the server can check a Credential's Challenge is one it issued |
| `SETTLER_PRIVATE_KEY` | Key that sends `settleDirect()`. Fund it with `cast rpc tempo_fundAddress` |
| `FACTORY_ADDRESS` | The invoice factory. Used to reject addresses that aren't its clones |
| `TEMPO_RPC_URL` | Defaults to `https://rpc.moderato.tempo.xyz` |
| `ALLOWED_ORIGIN` | The frontend origin, for CORS |
| `PORT` | HTTP port |

`mppx` setup:

```ts
const mppx = Mppx.create({
  methods: [tempo.charge({ testnet: true, currency: ALPHA_USD })],
  secretKey: process.env.MPP_SECRET_KEY,
});
```

`testnet: true` selects chain ID `42431` (Moderato). The `currency` here is only a placeholder that makes `tempo.charge` create a single offer (without it, it creates two). Each request overrides it with the invoice's token.

### 4.2 Quote

The quote is computed from the latest block timestamp `t` and the invoice's tiers:

- **Quote window:** `[t, t + 180 s]`. That is the 120 s Challenge expiry plus 60 s for broadcast and `settleDirect()`.
- **Quoted discount:** `quoteBps` = the smallest `activeDiscount` value at any instant in the window. A tier's discount applies up to its cutoff, so the candidates are `activeDiscount(t)` and `activeDiscount(c)` for each tier cutoff `c` with `t < c ≤ t + 180`. Call the contract's `activeDiscount` for each candidate rather than reimplementing tier logic. This follows base §3.5.
- **Amount:** `amount = principal − floor(principal × quoteBps / 10_000)`.

This keeps the payment at or above what `settleDirect()` requires, whenever it runs within the window. That includes the case where a later tier has a *larger* discount (base §3.5 allows that). The cost is that a payer quoted within 3 minutes of a cutoff pays at the next tier's price, and the difference goes to the seller. The Challenge `description` says so.

### 4.3 Endpoint: `POST /invoices/:address/pay`

On every request, with or without a Credential:

1. `address` must be a valid address → otherwise `400`.
2. The code at `address` must be the EIP-1167 clone runtime pointing to `factory.implementation()` → otherwise `404`. This stops a crafted URL from steering a payment to an arbitrary contract.
3. `getInvoice()`: `status` must be `Active` → otherwise `409` with the current status.
4. Work out the charge's `amount` and `description`:
   - **First request (no Credential):** compute the quote (§4.2).
   - **Retry (with a Credential):** if `Credential.fromRequest(request)` parses and `Challenge.verify(credential.challenge, { secretKey })` passes, reuse the **echoed** Challenge's `amount` and `description`. `mppx` pins both on the retry, so a quote recomputed seconds later could differ near a tier boundary, and `mppx` would then reject a valid payment. The HMAC proves this server issued the echoed values, `mppx` still pins `recipient` and `currency` to this request, and it enforces `expires`.
5. Call:

```ts
const result = await mppx.charge({
  amount,                  // display units, e.g. formatUnits(quoteAmount, 6)
  currency: invoice.token,
  recipient: address,
  expires: Expires.minutes(2),
  description,             // `Invoice ${decodeRef(invoice.invoiceRef)}: ${quoteBps / 100}% early-payment discount`
})(request);
if (result.status === 402) return result.challenge;
```

6. After a successful charge (`mppx` has found the wallet's transfer on-chain and checked it), send `settleDirect()` from the settler key and wait for the receipt.
7. Return `result.withReceipt(Response.json(body))`, where:

```ts
{
  invoice: Address,
  transferTx: Hash,        // from the MPP Receipt's `reference`
  amount: string,          // in token units
  discountBps: number,     // quoteBps
  settleTx: Hash | null,
  settled: boolean,
  settleError?: string     // decoded custom error if settleDirect reverted
}
```

If `settleDirect()` reverts, the payment has still been made. The server returns `200` with `settled: false`, and the frontend offers "Finish settlement" (§5.1).

### 4.4 CORS

The browser calls the server cross-origin, so:

- Allow request headers `Authorization` and `Accept-Payment`. The `mppx` client sends `Accept-Payment` on every request when it isn't polyfilling `fetch`.
- Expose response headers `WWW-Authenticate` and `Payment-Receipt`.
- Allow origin `ALLOWED_ORIGIN`.

### 4.5 Race with `fund`

The server checks for `Active` (step 3) on both the 402 request and the Credential request. A `fund` can still land between that check and the broadcast. The transfer then goes into a Funded clone and `settleDirect()` reverts `NotActive`. For the PoC that money is stuck (§7).

---

## 5. Frontend changes

### 5.1 InvoiceDetail actions

New `.env` key: `VITE_MPP_SERVER_URL`.

| Action | Shown when | Behaviour |
|---|---|---|
| **Pay now via MPP** | connected with **Tempo Wallet**, not the seller, `status == Active` | 1. `fetch` the endpoint with no Credential and read the Challenge from the 402 (`Challenge.fromHeaders`). 2. Show: "Pay **X AlphaUSD** now (Y% discount) to invoice `INV-…`. Quote valid until hh:mm:ss." 3. On confirm, call `mppx.fetch` (client `tempo.charge` with the connected account) to the same URL. It handles the 402, signs and retries. 4. Show the result and refetch `getInvoice` |
| **Finish settlement** | `status == Active` and the clone's token balance ≥ the amount due now | `invoice.settleDirect()`, sponsored. Anyone may click it |
| **Accept and settle** | the user is the seller, `status == Active`, and 0 < clone balance < the amount due now | Warns "You will receive X instead of Y", then `invoice.settleDirect()` |

Client setup:

- **Turn off the Accounts SDK's built-in MPP:** `tempoWallet({ feePayer: SPONSOR_URL, mpp: false })`. That option defaults to on and patches the global `fetch` to pay any 402 automatically, which would skip the confirm step.
- Create our own `mppx` client with `polyfill: false`. Use `tempo.charge({ getClient, expectedRecipients: [invoice], currencies: [invoice.token], maxAtomicAmount: String(principal) })`, where `getClient` comes from `(await connector.getProvider()).getMppxParameters()`. The allowlists make the client refuse a Challenge that pays anyone other than this invoice, in another token, or more than the principal.

### 5.2 "MPP exchange" panel

A collapsible panel under the Pay Now action, so the user can see the protocol at work:

| Step | Shows |
|---|---|
| Challenge | The 402 status, the raw `WWW-Authenticate` header, and the decoded request (`amount`, `currency`, `recipient`, `expires`, `description`) |
| Credential | That a Credential was sent, with method, intent and mode (push), and the transfer's tx hash linked to the explorer |
| Receipt | The raw `Payment-Receipt` header, decoded (`method`, `reference`, `status`, `timestamp`), with `reference` linked to the explorer |
| Settlement | `settleTx` linked to the explorer, or the `settleError` |

### 5.3 History

`useInvoiceHistory` adds the `SettledDirect` event as a lifecycle entry. It also shows the inbound transfer into the clone (sender, amount, MPP memo) so the payer is visible.

---

## 6. Tests

### 6.1 Foundry (`test/unit/`)

| Test | Checks |
|---|---|
| `test_SettleDirectExactAmount` | Transfer `due` into an Active clone; anyone calls `settleDirect`. Payout gets `due` with the `invoiceRef` memo; status Paid; `SettledDirect` emitted |
| `test_SettleDirectOverpaymentGoesToSeller` | Balance > `due`, so the payout gets the whole balance |
| `test_SettleDirectUnderpaymentReverts` | A non-seller with balance < `due` reverts `InsufficientDirectPayment` |
| `test_SettleDirectSellerAcceptsUnderpayment` | The seller with balance < `due` succeeds and the payout gets the balance |
| `test_SettleDirectNothingToSettle` | Balance 0 reverts `NothingToSettle`, even for the seller |
| `test_SettleDirectOnlyWhenActive` | Funded, Paid and Cancelled all revert `NotActive` |
| `test_FundAfterSettleDirectReverts` | `fund` on a Paid invoice reverts `NotActive` |
| `test_SettleDirectTierBoundary` | A payment quoted with the window minimum still settles after a cutoff passes |

### 6.2 Server (vitest)

- `quoteBps`: no tiers; inside a tier with no cutoff in the window; a cutoff inside the window (decreasing tiers); a cutoff inside the window where the next tier has a **larger** discount; past the due date.
- The endpoint returns `404` for a non-clone address, `409` for a non-Active invoice, and `402` with the expected `amount`, `currency` and `recipient`.

### 6.3 End-to-end (manual, Moderato)

Add a section to [`../e2e-checklist.md`](../e2e-checklist.md):
1. Create an invoice.
2. As another Tempo Wallet user, Pay now via MPP.
3. Confirm the Challenge in the panel, the transfer into the clone, the forward to payout with the `invoiceRef` memo, the status Paid, and the `SettledDirect` entry in history.

---

## 7. Risks to document (not handled in code)

- **Payment into a non-Active clone** (the race in §4.5, or a stray transfer): the funds stay in the clone and there is no rescue path. This matches the base spec's position on stuck funds (base §7).
- **Underpayment** can only happen if a quote outlives its window, for example a delayed broadcast. The seller can recover with "Accept and settle".
- **Server trust:** the server can't redirect funds, because the Challenge recipient is the verified clone and the Credential is bound to the Challenge. It *can* refuse service, or fail to call `settleDirect()`. Anyone can call that function, so the second failure is recoverable.
- The TIP-20 pause, block and receive-policy risks in base §3.9 also apply to the forward transfer in `settleDirect()`.

---

## 8. Out of scope

- Injected wallets for MPP payments; a CLI or agent client; a raw `curl` walkthrough.
- The `session` intent, `autoSwap`, MACH funding, or paying in a token other than the invoice's.
- Recording the payer on-chain as `buyer`.
- Rescuing funds sent to a non-Active clone.
- Running our own fee sponsor. The public Moderato relay is used, as in the base spec.
- Mainnet.

---

## 9. Verified before implementing

Resolved on 2026-10-19 against `mppx` 0.13.5. Details are in [`verification-notes.md`](verification-notes.md#mpp-pay-now-spike-s1-of-planmpp-pay-now-dagmd) (items 1–5), and the outcomes are applied above:

1. **Client with the wagmi `tempoWallet` connector:** works through the provider's `getMppxParameters().getClient` (§5.1). The provider's built-in MPP must be turned off (`mpp: false`).
2. **Credential re-check vs. a fresh quote:** `mppx` pins `amount` and `description`, so the retry reuses the echoed Challenge's values (§4.3 step 4).
3. **Sponsored pull Credential:** not used. The wallet pushes a transfer sponsored by its own fee payer, and the server has no `feePayer` (§2). The first live payment (plan I1/I2) confirms this with a passkey.
4. **CORS headers:** `Accept-Payment` is also sent (§4.4).
5. **Clone code:** confirmed against a deployed clone.
