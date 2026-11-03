# InvoiceDiscount on Ethereum: Pay Now via Mesh

> Status: draft, revised November 2026 after the Ethereum port was implemented and deployed on Sepolia, and again after the Mesh spike (S1) found that the dashboard's keys are for the **Mesh Pay v2 API**, not the legacy API the first draft followed. Planned in [`../plan/mesh-pay-now-dag.md`](../plan/mesh-pay-now-dag.md). It builds on the port ([`invoice-discount-spec.md`](invoice-discount-spec.md), the "port spec"; §3) and reuses the Pay now design from the Tempo MPP spec ([`../../../tempo/docs/spec/mpp-pay-now-spec.md`](../../../tempo/docs/spec/mpp-pay-now-spec.md), the "MPP spec"), but swaps MPP for Mesh as the way the money arrives. How Mesh works is covered in [`../explainer/mesh-how-it-works.md`](../explainer/mesh-how-it-works.md).

---

## 1. Goal

Let a buyer pay an Active invoice **from any exchange account or wallet Mesh supports** (Coinbase, Binance, MetaMask, Rainbow and others), not only from a wallet connected to our app. The buyer pays the discounted amount that applies right now, and the invoice settles in one step.

The flow:

1. The buyer clicks **Pay with Mesh** on an Active invoice.
2. Our new **mesh-server** checks the invoice, works out the amount due now, and asks Mesh for a **payment session**: a single-use token for Mesh Link that pays exactly that amount, in the invoice's token, on Ethereum, to the **invoice clone's address**.
3. The frontend opens **Mesh Link** (Mesh's hosted modal) with the token. The buyer connects an exchange or wallet and approves the transfer inside Link. When Link closes, the frontend polls mesh-server for the outcome.
4. Mesh moves the funds into the clone and sends mesh-server a signed **webhook** (`transfer.completed`) when the transfer succeeds.
5. mesh-server checks on-chain that the clone holds enough, then calls the permissionless **`settleDirect()`**. The invoice becomes Paid and the funds go to the seller's payout address.

The existing fund → trigger path stays. Whichever path settles an Active invoice first wins.

---

## 2. Design decisions

| Topic | Decision | Why |
|---|---|---|
| Chain | **Ethereum**, with **Sepolia** (`eip155:11155111`) for development | Mesh's sandbox has no Tempo testnet. Sepolia is a sandbox testnet with real on-chain wallet transfers |
| Mesh API | **Mesh Pay v2** (`api.sbx.meshpay.com`): OAuth client credentials, `POST /v2/sessions`, `@meshpayhq/link-web-sdk`, envelope webhooks (explainer §3–§6) | The dashboard's keys are for v2; the legacy API in the public docs rejects them (verification notes, Mesh spike) |
| Invoice path | **Pay now via `settleDirect()`** (port spec §3.5), unchanged. **No contract change** | A Mesh transfer is a plain token transfer, so it can't call `fund()`, which pulls tokens with `transferFrom`. `settleDirect()` already settles from the clone's balance |
| Who is paid | The **invoice clone** is the Mesh `toAddress`. It forwards the funds to the payout address in `settleDirect()` | Keeps the contract the source of truth for status. Each invoice has its own address, so Mesh's transfer is attributed to the invoice without a memo |
| Mesh transfer type | **`TRANSFER_TYPE_PAYMENT`**, with one destination and its exact token `amount` | `payment` is Mesh's fixed-amount flow. A `deposit` lets the user pick the amount, which invites underpayment. The amount is given in token units, not `amountInFiat`, because the contract checks a token amount |
| Fees | Not configurable in v2 (no `isInclusiveFeeEnabled`). `amount` is what the destination should receive | If Mesh delivers less, the balance check refuses to settle (`needs-attention`) and the seller can Accept and settle. Checked in the end-to-end run (§6.3) |
| Tokens | Only invoices whose token is in the Mesh-supported list. On Sepolia: **PYUSD** and **USDG** | Pay with Mesh is hidden for other tokens, including **USDC**. Mesh's sandbox docs list Sepolia wallet transfers in **native ETH only**, though session creation accepts PYUSD and USDG; the plan's I1 checks in Link first (user decision), and if Link can't pay ERC-20 the user asks Mesh to enable it (§6.2) |
| Sources of funds | **Mesh Link** with exchanges and wallets, including the manual send-to-address path Link offers | What "any wallet" means in this PoC. Cross-chain bridging is out of scope (§8) |
| Pricing | Same idea as MPP spec §4.2: the **smallest discount that applies at any moment in the quote window** | The payment must still cover the amount due when `settleDirect()` runs. The window here is longer (§4.2) |
| Confirmation | The **webhook is a trigger, the chain is the truth.** mesh-server settles only after checking the clone's on-chain balance | Webhooks can be retried, delayed or (in sandbox) describe simulated transfers. A false `completed` must never cause a bad settlement. `settleDirect()` enforces the amount anyway |
| Gas for `settleDirect()` | Paid in Sepolia ETH by the mesh-server **settler key** | Ethereum has no fee sponsorship. The key has no special rights in the contract |
| Gas for the payer | Handled inside Mesh Link: exchanges pay their own withdrawal fees; wallet users pay ETH gas from their own wallet | The buyer doesn't need a wallet connected to our app |
| Server | New **`ethereum/mesh-server/`** service, started from a copy of `tempo/mpp-server/` (Hono + viem) with `mppx` removed | User decision. It holds the Mesh client secret (and the bearer token it mints), the webhook secret and the settler key. Copying keeps the proven clone check and quote code (§4.1), the same way the port copied the Tempo frontend |
| Session state | **In memory**, one instance. `clientTransactionId` encodes the invoice address (§4.3) | As `mpp-server`. A restart loses session details, but a later `completed` webhook can still be acted on: the invoice is read from `client_transaction_id` and the chain decides |
| Buyer identity | Not recorded on-chain. The payer's source (wallet or exchange name) and, for wallets, the sending address come from the webhook and are shown off-chain. v2 webhooks carry no refund address (user decision: show what the webhook has) | Same position as the MPP spec: a permissionless `settleDirect()` can't prove who paid |

---

## 3. What the Ethereum port provides

The port is specified in the port spec and implemented:

- **Contracts:** interface frozen at tag `ethereum-interface-v1`, deployed on Sepolia (factory `0x58B4989074B20af8331C048D7535c70f534299d4`, implementation `0x1619ba96564c733204173cC201f1B9D3Ab9280d1`, deploy block `12056811`; see `contracts/deployments/sepolia.json`). They already include `settleDirect()`, `getInvoice()`, `activeDiscount()` and the `SettledDirect` event with an indexed `invoiceRef`. **This feature changes no contract, needs no new interface tag and no redeploy.**
- **Frontend:** already has Finish settlement and Accept and settle (port spec §5.3), and its history already shows the inbound ERC-20 `Transfer` events into a clone next to `SettledDirect` (port spec §5.4). `src/lib/` is frozen at tag `ethereum-frontend-interface-v1`; this feature adds to it (§5), so it needs approval and a new tag, `ethereum-frontend-interface-v2`.
- **End-to-end:** the e2e run ([`../e2e-checklist.md`](../e2e-checklist.md) §6) confirmed on Sepolia that a plain PYUSD transfer into an Active clone followed by `settleDirect()` settles the invoice. That is exactly what a Mesh payment does, with Mesh making the transfer.

These Tempo → Ethereum differences matter for Mesh:

| Tempo | Ethereum | Effect on this spec |
|---|---|---|
| TIP-20 `transferWithMemo` puts `invoiceRef` on every escrow transfer | ERC-20 has no memo | The forward transfer in `settleDirect()` can't carry `invoiceRef`. Reconciliation instead uses the `SettledDirect` event (`invoiceRef` is its topic 2), plus the `clientTransactionId` we give Mesh (§4.3) |
| Gas paid in a stablecoin, sponsored by the app | Gas paid in ETH, no sponsorship | The settler key needs Sepolia ETH. Buyers who pay from a wallet need ETH for gas |
| ~0.5 s blocks | ~12 s blocks | The latest block timestamp can be up to ~12 s old, and `settleDirect()` takes one or two blocks to land. Both go into the quote allowance (§4.2) |
| Tempo Wallet (passkeys) as the primary connector | Injected wallets (MetaMask etc.) | Only the seller needs to connect to our app. The buyer connects inside Mesh Link. The invoice page already reads the chain with no wallet connected |
| Any TIP-20, all with 6 decimals | Any ERC-20; decimals vary | The quote must use the token's own `decimals()`. PYUSD and USDG both use 6 (verification notes items 1a, 1c) |
| TIP-20 pause/blocklist risks | PYUSD and USDG can be paused, can freeze addresses and can wipe a frozen balance | Port spec §3.9 applies to the inbound Mesh transfer and to the forward transfer |
| `isTIP20` check at invoice creation | No equivalent registry; the port checks only that the token address has code (`InvalidToken`) | None. mesh-server accepts only Mesh-supported tokens (§4.3), which are a subset of the frontend's list |

---

## 4. mesh-server (`ethereum/mesh-server/`)

### 4.1 Responsibilities

1. **Start a payment:** validate the invoice, quote it, create a Mesh payment session, and return its token to the frontend.
2. **Receive webhooks:** verify each one, and settle the invoice when the funds are confirmed on-chain.
3. **Report status:** let the frontend poll a payment's progress after Link closes.

It needs these secrets and settings, read once at startup from `.env`:

| Var | Meaning |
|---|---|
| `MESH_CLIENT_ID` | Mesh client id. Public: it's also returned to the frontend for the Link SDK |
| `MESH_API_KEY` | Mesh client secret, for OAuth client credentials |
| `MESH_API_URL` | Mesh API base URL, default `https://api.sbx.meshpay.com`; its host is the OAuth `audience` |
| `MESH_LINK_ENV` | The Link SDK `environment` returned to the frontend: `sbx` (default) or `prod` |
| `MESH_WEBHOOK_SECRET` | Signing secret of the registered webhook endpoint |
| `MESH_NETWORK_CAIP2` | The target network, default `eip155:11155111` (Sepolia) |
| `MESH_TOKENS` | Mesh-supported tokens as `SYMBOL:address`, comma-separated |
| `SETTLER_PRIVATE_KEY` | The settler key |
| `FACTORY_ADDRESS` | `0x58B4…99d4` |
| `SEPOLIA_RPC_URL` | Sepolia RPC |
| `ALLOWED_ORIGIN` | The frontend origin, for CORS |
| `PORT` | Default `8788`, so it can run next to `mpp-server` (8787) |

As in `mpp-server`, the origin must match the browser's address bar exactly (`http://localhost:5173`, not `127.0.0.1`). The server only reads single contracts and sends transactions, so the RPC has no `eth_getLogs` range requirement.

Code carried over from `tempo/mpp-server/src/`: `invoice.ts` (`isClone`: the EIP-1167 runtime check against `factory.implementation()`, which is the same 45 bytes on Ethereum, and `readInvoice`) and `quote.ts` (`quoteBps`, `quoteAmount`), with only the window length changed. The ABIs go in `mesh-server/src/abi/`, generated by the frontend's `sync-abi` script, which is extended to write both packages as on Tempo.

### 4.2 Quote

As in MPP spec §4.2, with a longer window:

- **Window start:** the latest block timestamp `t`.
- **Window length:** **900 s**: the quote's own 10-minute life (§4.3 step 7) plus 5 minutes for the transfer to land on-chain and for `settleDirect()` to be included. Wallet transfers land within a few blocks. Exchange withdrawals can take much longer, and Mesh says exchanges may take "seconds to days" to post. A payment that lands after the window may be short (§7). A Mesh session itself lives about an hour; the frontend doesn't open Link once the quote has expired, but a buyer who lingers inside an open Link can still pay late (user decision: keep the 900 s window).
- **Discount:** the smallest `activeDiscount` value at any instant in the window, found by calling the contract at `t` and at each tier cutoff inside the window (`quoteBps`, unchanged from `mpp-server`).
- **Amount:** `principal − floor(principal × quoteBps / 10_000)` (`quoteAmount`), sent to Mesh as the decimal string `formatUnits(amount, decimals)`, which is exact.

### 4.3 Endpoints

**`POST /invoices/:address/mesh-session`** (called by the frontend)

1. `address` must be a valid address → otherwise `400`. It must be a clone of the configured factory's implementation → otherwise `404`. This stops a crafted URL from sending a payment to an arbitrary contract.
2. `getInvoice()`: status must be `Active` → otherwise `409` naming the status.
3. The invoice token must be a token Mesh supports on the target network → otherwise `422`.
4. The clone's balance must be below the amount due now → otherwise `409` saying it is already paid. The invoice then only needs settling, and the frontend offers Finish settlement (port spec §5.3) instead.
5. Compute the quote (§4.2).
6. Create a Mesh payment session: `POST /v2/sessions` with `Authorization: Bearer <token>` and `Idempotency-Key: mesh-session-<session id>`, and:
   - `transferOptions.type: "TRANSFER_TYPE_PAYMENT"`
   - one `toAddresses` entry: `networkCaip2` (`MESH_NETWORK_CAIP2`), the token symbol, the clone address, and the quoted `amount` as a decimal string
   - `transferOptions.clientTransactionId` of `<invoice address, lowercase>-<session id>`, where the session id is 16 random hex characters (59 characters in all), so webhooks map back to the invoice even after a restart
   - a `userId` of `buyer-<session id>`: random per session, so it isn't personal data and doesn't link one buyer's payments

   The bearer token comes from `POST /oauth2/token` (client credentials, HTTP Basic, `audience` = the API host, `scope=sessions:edit`) and is cached until shortly before it expires. If minting the token or creating the session fails → `502`.
7. Record the session (invoice, quote, `clientTransactionId`, expiry = **the latest block's timestamp + 600 s**: the quote's life, not the Mesh session's) and return `201 { id, linkToken, clientId, linkEnvironment, amount, displayAmount, symbol, discountBps, expiresAt }` to the frontend. `linkToken` is Mesh's single-use session `token`; `clientId` and `linkEnvironment` are what the Link SDK needs; `amount` is in base units (a decimal string), `displayAmount` is what Mesh was sent, and `expiresAt` is unix seconds.

**`POST /webhooks/mesh`** (called by Mesh)

1. Verify `X-Mesh-Signature-256`: `sha256=` followed by the hex HMAC-SHA256, under the webhook secret, of `"{X-Mesh-Timestamp}.{raw body}"`; and check that `X-Mesh-Timestamp` (unix seconds) is within **300 s** of now. Reject with `401` if either header is missing or the check fails, and with `400` if it passes but the body isn't a JSON object.
2. Return `200` straight away (well inside Mesh's 30 s per-attempt timeout) and process the event in the background.
3. Ignore (still with `200`) an event whose `version` isn't `"1"`, whose `type` doesn't start with `transfer.`, or that has no `data.transfer`; and any event whose `event_id` has already been seen.
4. Map `data.transfer.client_transaction_id` to its session (or, if the session was lost, to the invoice it encodes, which must be a clone of the factory's implementation; a session record is then created with no quote). An undecodable id is ignored.
5. Branch on `data.transfer.status`, not `type`:
   - `pending` or `compliance_hold`: mark the session pending.
   - `failed` or `refunded`: mark the session failed, with `error_code` (or `error_message`, or the status) as the reason. The buyer can start again.
   - `completed`: ignored if the session is already `settled`. Otherwise record the payer details (`source.crypto.venue` or `source.kind`, and `source.crypto.address`) and the destination `tx_hash`. Check that `destination.crypto.address` is the invoice, and that `destination.crypto.network_caip2` and `.asset.symbol`, when present, are the expected network and the invoice token's symbol; otherwise the session needs attention and nothing is settled. Then wait up to **180 s** (15 blocks) for the `tx_hash` receipt on our RPC. **Whether or not the receipt is found**, read the clone's on-chain token balance: the chain decides. If the invoice is still Active and the balance covers the amount due now, call `settleDirect()` and wait for its receipt. Otherwise, or if `settleDirect()` reverts, record why (decoded custom error). If the invoice is already Paid when checked, record that instead of trying.
   - anything else: ignored.

   A non-terminal status never overwrites a terminal one. Events for one invoice are handled one at a time.

**`GET /invoices/:address/mesh-session/:id`** (called by the frontend)

Returns the session's state: `awaiting-transfer`, `pending`, `succeeded`, `settled` (with the `settleDirect` tx hash), `failed`, or `needs-attention` (funds arrived but settling didn't happen, with the reason). It also returns the payer details from the webhook: source provider and, for a wallet, source address. The body is `{ id, invoice, state, amount, discountBps, expiresAt, transferTx?, settleTx?, reason?, payer? }`. An unknown id, or the id of another invoice's session, is `404`.

**`GET /invoices/:address/mesh-sessions`** (called by the frontend)

Returns `{ sessions: [...] }`, the invoice's sessions in the same shape, newest first (`[]` if none). Any viewer, including the seller, can then see how an invoice was paid while mesh-server still holds the session.

### 4.4 Local development

Mesh has to be able to reach the webhook URL over the public internet (HTTPS, port 443). In local development that means a tunnel. The endpoint is registered in the dashboard under **Account > Webhooks** and subscribed to `transfer.status_updated` (the catch-all, so every status reaches us). Its signing secret is shown once.

---

## 5. Frontend changes

On the existing `ethereum/frontend/`. New `.env` key `VITE_MESH_SERVER_URL`; if it is unset, Pay with Mesh is hidden. New dependency: `@meshpayhq/link-web-sdk`. The list of Mesh-supported token addresses lives in the frontend config as data (§6.1).

| Action | Shown when | Behaviour |
|---|---|---|
| **Pay with Mesh** | `status == Active`, the token is Mesh-supported, the clone's balance is below the amount due now, and the viewer isn't the seller. **No wallet connection is required** (no account counts as "not the seller") | 1. Call `mesh-session`. 2. Show "Pay **X PYUSD** now (Y% discount) to invoice `INV-…`. Quote valid until hh:mm:ss." 3. On confirm, open Mesh Link: `openLink(linkToken, clientId, { environment: linkEnvironment, target: { mode: 'modal' } })`. 4. On `onExit` (Link closed, paid or not), poll the session status until it is settled, failed or needs attention, refetching the invoice and its balance as it changes. A session still `awaiting-transfer` after its quote expires counts as abandoned. `onError` (Link didn't start) shows the error |
| **Finish settlement** | As port spec §5.3 | Unchanged. It's the fallback if mesh-server didn't settle. It still needs a connected wallet with Sepolia ETH |
| **Accept and settle** | As port spec §5.3 | Unchanged. It's the seller's fallback for a short payment (§7) |

The rule goes in `visibleActions` (`src/lib/actions.ts`) as a new `payWithMesh` flag, with the Mesh-supported check passed in as part of the context. That changes the frozen `src/lib/` interface (§3). Today every flag there is false when no account is connected; `payWithMesh` is the first exception.

The Link SDK callbacks drive the UI only; v2 has no success callback. A payment counts as done when the session reaches `settled`, or when the invoice status reads Paid on-chain.

Invoice history already shows the inbound transfer into the clone and the `SettledDirect` event (port spec §5.4). For an exchange payment the sender shown there is the exchange's hot wallet, not the buyer (explainer §7). The new part is a "Paid via Mesh" line with the payer details (source provider and, for a wallet, sender address) from the invoice's latest session in `GET /invoices/:address/mesh-sessions`, while mesh-server still holds it.

---

## 6. Prerequisites and testing

### 6.1 Before building

- A **Mesh dashboard account**. It's invite-only, through a Mesh representative.
- **Sandbox API keys** (the API keys page's Sandbox toggle): client id and secret.
- A **webhook endpoint** registered under **Account > Webhooks** (the tunnel, §4.4), subscribed to `transfer.status_updated`, with its signing secret.

The spike (plan node S1) resolved the rest; see [`verification-notes.md`](verification-notes.md), Mesh pay-now spike. In short: auth is OAuth client credentials and works with the sandbox keys; the network is `eip155:11155111` and the symbols are `PYUSD`/`USDG`; the session, webhook and signature formats are as in §4.3. **Open:** whether Link offers an ERC-20 (PYUSD/USDG) wallet transfer on Sepolia (§6.2), and whether the destination receives the full `amount` (§2, Fees).

### 6.2 What the sandbox can and can't prove

- **Wallet flows** (MetaMask, Phantom or Rainbow on Sepolia) make **real on-chain testnet transfers**. They are the only way to test the whole path, from Link to the webhook to `settleDirect()` to Paid. Mesh's sandbox docs list Sepolia with its **native token (ETH) only**. If Link offers no PYUSD/USDG transfer, the whole path can't be shown in the sandbox until Mesh enables it; the settle path is then tested with a sandbox exchange payment plus a plain PYUSD transfer into the clone (plan I2).
- **Exchange flows** (mock exchanges such as `mock_coinbase`) move **no real assets**, and their webhooks carry synthesized data. They test the Link UX and webhook handling. The on-chain check (§4.3 step 5) should then refuse to settle, and that refusal is itself a useful test.
- No logic depends on a `pending` webhook arriving.

### 6.3 Tests

- **Contracts:** none. The `settleDirect` tests from the port's suite cover the contract side.
- **Server unit tests** (vitest, against a fake chain as in `mpp-server`): the quote window (including tier cutoffs and the due date) with the new window length; clone validation; the `mesh-session` error codes (§4.3); the OAuth token request and its caching, and the session request body and headers (with Mesh's API mocked); the timestamped HMAC against the raw body, including Mesh's test vector and a stale timestamp; deduplication by `event_id`; ignored versions and types; a `completed` event with an insufficient balance not settling; a mismatched destination; a webhook for an already-Paid invoice; a webhook whose session is unknown.
- **Frontend unit tests:** the `payWithMesh` flag in `visibleActions`, including with no account connected and for a USDC invoice.
- **End-to-end (manual, Sepolia):** a new section in [`../e2e-checklist.md`](../e2e-checklist.md). Create a PYUSD invoice, then pay it through Mesh Link from MetaMask on Sepolia, with no wallet connected to our app. Confirm the transfer into the clone (and whether it is the full amount), the `transfer.completed` webhook, the `settleDirect` transaction, the payout, the Paid status and the history entry. Then a sandbox exchange payment (no real transfer), which must end in `needs-attention` with the invoice still Active.

---

## 7. Risks (documented, not handled in code)

- **Late arrival and a short payment:** if an exchange posts the transfer after the quote window and a tier cutoff has passed, the amount due goes up, and `settleDirect()` reverts for anyone except the seller. The seller can use Accept and settle. mesh-server reports `needs-attention`.
- **Payment into a non-Active clone:** this happens on a race with `fund`, on a second Mesh payment, or when the seller cancels while a transfer is in flight. The funds stay in the clone, and there's no rescue path (port spec §3.9, stray transfers). v2 webhooks carry no refund address, so a future rescue feature would need the sender from the transfer record.
- **Manual (send-to-address) deposits** let the buyer send any amount from any wallet. An underpayment is handled as above. An overpayment goes to the seller, because `settleDirect()` forwards the whole balance.
- **Server trust:** mesh-server can't redirect funds, because the destination is the verified clone. It can fail to settle, but anyone can call `settleDirect()`.
- **Mesh as a dependency:** if Mesh is down or the webhook is lost, the funds still reach the clone, and Finish settlement covers the gap.
- **Token issuer controls:** a pause, or a frozen clone or payout address, blocks the inbound transfer or `settleDirect()` (port spec §3.9).
- **Settler key:** if it runs out of Sepolia ETH, `settleDirect()` fails and the session goes to `needs-attention`; Finish settlement covers it. Concurrent settlements share its nonce sequence, relying on viem's nonce handling as in `mpp-server`.

---

## 8. Out of scope

- **Cross-chain bridging** (for example USDC on Solana → Ethereum). Mesh bridges into Ethereum, but only on mainnet, and headless bridging has to be enabled per client.
- Mainnet and production Mesh keys.
- Escrow funding (the Funded state) through Mesh.
- Pay links, fiat ramps, wallet verification, and mobile SDKs (not live in v2).
- Recording the payer on-chain, and refunds.
- Contract changes, and persisting sessions across mesh-server restarts.
