# How Mesh Works: APIs and Integration

> An explainer for the Pay with Mesh feature ([`../spec/mesh-pay-now-spec.md`](../spec/mesh-pay-now-spec.md)). Rewritten November 2026 for the **Mesh Pay v2 API** (`api.meshpay.com`), from the Mesh developer MCP server's docs and OpenAPI schema. An earlier version followed the public docs at docs.meshconnect.com, which describe Mesh's **legacy** integration API (`integration-api.meshconnect.com`, `X-Client-Id`/`X-Client-Secret` headers, `/api/v1/linktoken`, `@meshconnect/web-link-sdk`). The dashboard's keys don't work there. What was probed live is in [`../spec/verification-notes.md`](../spec/verification-notes.md) (Mesh pay-now spike).

---

## 1. What Mesh is

Mesh (also sold as Mesh Pay) is a **crypto payments network**. It lets a user pay from accounts they already have, such as an exchange account (Coinbase, Binance and others) or a self-custody wallet (MetaMask, Phantom, Rainbow and 170+ more through WalletConnect), without our app integrating each one.

Mesh handles the parts that differ for every source: logins, MFA, wallet connections, choosing the network, routing and quoting, compliance checks, and the transfer itself. We tell Mesh *where the money should go and how much*, and Mesh gets it there.

The thing to understand: **Mesh doesn't hold the money in between.** The transfer goes on-chain from the user's account straight to the address we give. For us, that's the invoice clone.

---

## 2. The three parties

```
   OUR SERVER                     OUR FRONTEND                        MESH
  (mesh-server)                 (browser, Link SDK)          (API + hosted Link UI)
       │                                │                              │
       │◄──── 1. "pay invoice 0x…" ─────│                              │
       │──── 2a. POST /oauth2/token ────┼─────────────────────────────►│  (cached ~30 min)
       │──── 2b. POST /v2/sessions ─────┼─────────────────────────────►│
       │◄───────────────────────────────┼──── token (exchange code) ───│
       │───── 3. token, clientId ──────►│                              │
       │                                │── 4. openLink(token, …) ────►│  user connects
       │                                │                              │  MetaMask / Coinbase,
       │                                │                              │  approves transfer
       │                                │◄────────── 5. onExit ────────│  (paid or not)
       │                                │                              │── 6. transfer ──► chain
       │◄───────────────────────────────┼── 7. webhook transfer.completed
       │── 8. settleDirect() ───────────┼──────────────────────────────┼───────────────► chain
```

| Party | Does | Holds |
|---|---|---|
| **Our server** | Mints OAuth tokens, creates sessions, receives webhooks, makes business decisions | Client secret, webhook signing secret |
| **Our frontend** | Shows a button, opens Link, polls our server | The single-use session token and the (public) client id |
| **Mesh** | Runs the whole user journey and the transfer, then reports the outcome | The user's connections |

---

## 3. Environments and authentication

| | Sandbox | Production |
|---|---|---|
| API host | `https://api.sbx.meshpay.com` | `https://api.meshpay.com` |
| Link SDK `environment` | `'sbx'` (Link at `link.sbx.meshpay.com`) | `'prod'` (default) |
| Funds | Mock exchanges; wallet transfers on public testnets | Real |

Auth is **OAuth 2.0 client credentials**, the only scheme in every environment:

```bash
curl -X POST https://api.sbx.meshpay.com/oauth2/token \
  -u "$MESH_CLIENT_ID:$MESH_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d audience=api.sbx.meshpay.com \
  -d "scope=sessions:edit"
```

- HTTP **Basic** auth only; credentials in the form body are rejected.
- `audience` is the API host.
- The response is `{ access_token, token_type: "Bearer", expires_in, scope }`. `expires_in` was 1799 s in the sandbox. Cache the token on the server and mint a new one shortly before it expires.
- Every `/v2` call sends `Authorization: Bearer <access_token>`.
- Every `/v2` **POST** also sends an `Idempotency-Key` header (printable ASCII, up to 128 characters, kept 24 h per client). Reusing a key on a retry avoids duplicate side effects.
- Errors use one envelope: `{ error: { code, message, requestId, details } }`.

The client id is **public**: the browser passes it to the SDK. The client secret and the bearer token never leave the server.

In the dashboard we:

- create API keys (the API keys page has its own Sandbox/Production toggle)
- register a **webhook endpoint** (HTTPS, port 443, public) and store its signing secret, which is shown once
- subscribe the endpoint to event types by exact name (no wildcards)

---

## 4. The session: configuring a payment

Every payment starts with `POST /v2/sessions` from our server. For a fixed-amount payment:

```jsonc
{
  "userId": "buyer-7f3a…",                      // stable, non-PII id for the user
  "transferOptions": {
    "type": "TRANSFER_TYPE_PAYMENT",
    "clientTransactionId": "0xabc…-7f3a…",       // ours, ≤ 255 chars; echoed on webhooks
    "toAddresses": [
      {
        "networkCaip2": "eip155:11155111",       // CAIP-2 chain id; friendly names are rejected
        "symbol": "PYUSD",
        "address": "0x<invoice clone>",
        "amount": "9450.00"                       // EXACT token amount, as a string
      }
    ]
  }
}
```

The response is `{ token, sessionId, expiresAt, sessionUrl }`:

- `token` is a **single-use exchange code**. The SDK swaps it for a session JWT, so we hand it to the browser once, for one `openLink()` call.
- A session lives about **1 hour**.
- `sessionUrl` is the same code in a ready-to-open Link URL, for when the SDK can't run. We use the SDK.

Two ways to set the amount:

| Field | Meaning |
|---|---|
| `toAddresses[].amount` | The exact amount of `symbol` to deliver. **What we use**: the contract needs a token amount |
| `transferOptions.amountInFiat` `{ value, currency }` | A fixed fiat price; Mesh converts it. Not used |

`toAddresses` is an array. A merchant usually lists every network/token pair it can receive, so Mesh can pick whichever the user holds. We list a single entry, because each invoice accepts one token on one network.

---

## 5. The Link SDK: the user journey

The web SDK is `@meshpayhq/link-web-sdk`, the only Mesh SDK live today.

```ts
import { openLink } from '@meshpayhq/link-web-sdk';

const handle = openLink(token, clientId, {
  environment: 'sbx',
  target: { mode: 'modal' },    // or 'popup' (needs a user gesture) or 'iframe'
  onExit: () => {},             // the user left, paid or not
  onError: (error) => {},       // Link failed to start: 'popup-blocked' | 'load-error' | 'load-timeout'
});
// handle.close() closes Link from our side
```

Inside Link the user:

1. Picks a source: an exchange, a wallet, or a **manual deposit** (send to an address from anywhere).
2. Connects it. For an exchange this includes login and MFA; for a wallet, a wallet connection.
3. Sees a **preview** with the amount, network and fees.
4. Approves. For an exchange, Mesh asks the exchange to withdraw to our address. For a wallet, the user signs the transaction in the wallet.

> **There is no success callback.** `onExit` fires exactly once, whether the user paid or gave up. Our frontend therefore treats `onExit` as "Link closed" and polls mesh-server for what actually happened. The server learns it from webhooks.

---

## 6. Webhooks: the source of truth

Mesh POSTs a signed JSON event to our endpoint every time a transfer changes status. It arrives even if the user has closed the tab.

### Envelope

```json
{
  "version": "1",
  "event_id": "01a0871b-…",              // stable across retries → idempotency key
  "type": "transfer.completed",
  "occurred_at": "2026-08-07T12:00:00Z",
  "sent_at": "2026-08-07T12:00:00Z",
  "delivery_id": "c7d20a41-…",
  "delivery_attempt": 1,
  "client_id": "org-…",
  "data": {
    "transfer": {
      "transfer_id": "t_01J9…",
      "status": "completed",
      "source":      { "kind": "wallet", "crypto": { "address": "0x…", "venue": "metamask", "network_caip2": "eip155:11155111", "asset": { "symbol": "PYUSD", "decimals": 6 }, "amount": { "value": "9450.00" }, "tx_hash": "0x…" } },
      "destination": { "kind": "wallet", "crypto": { "address": "0x<invoice clone>", "network_caip2": "eip155:11155111", "asset": { "symbol": "PYUSD", "decimals": 6 }, "amount": { "value": "9450.00" }, "tx_hash": "0x…" } },
      "hops": [],
      "created_at": "…",
      "completed_at": "…",
      "session_id": "01a0…",
      "client_transaction_id": "0xabc…-7f3a…"
    },
    "previous_status": "pending"
  }
}
```

- Field names are **snake_case**, unlike the camelCase REST API.
- Amounts are strings. Optional fields are omitted, never sent as `""` or `0`.
- `source.crypto.address` is absent for an exchange, since the exchange's custody sends it; `venue` names the wallet or exchange.
- There is **no refund address**.

### Types and statuses

| `type` | Fires when |
|---|---|
| `transfer.pending` | Accepted and in flight |
| `transfer.completed` | Terminal success: funds delivered |
| `transfer.failed` | Terminal failure (also covers cancelled and expired) |
| `transfer.refunded` | Terminal: funds went back to the sender |
| `transfer.status_updated` | Catch-all: every transition. Branch on `data.transfer.status` |

`data.transfer.status` is one of `pending`, `completed`, `failed`, `compliance_hold` or `refunded`. We branch on it rather than on `type`.

### Handling rules

1. **Verify the signature.**
   - `X-Mesh-Signature-256` is `sha256=` followed by the **hex** HMAC-SHA256 of `"{X-Mesh-Timestamp}.{raw body}"`, using the signing secret.
   - `X-Mesh-Timestamp` is unix seconds. Reject a delivery whose timestamp is more than 5 minutes off.
   - Use the raw bytes, never re-serialized JSON.
2. **Acknowledge fast** with `2xx`, then do the work in the background. Mesh's per-attempt timeout is 30 s, with 5 attempts over about 75 s.
3. **Acknowledge and ignore** an unknown `type` or a `version` other than `"1"`.
4. **Expect duplicates and reordering.** Delivery is at-least-once, so deduplicate on `event_id`. A non-terminal status never overwrites a terminal one.
5. **Match on `client_transaction_id`**, the id we set in the session.

`GET /v2/transfers?clientTransactionId=…` lists transfers for reconciliation, but webhooks are the primary path.

---

## 7. Payer identity

- **`source.crypto.address`** is the wallet that sent the transfer. For an exchange it's absent, because the exchange's custody sends it and many users share it.
- **`source.crypto.venue`** names the wallet or exchange (`metamask`, `coinbase`).

There's no refund address in v2. This is also why our contract can't learn the payer from the inbound transfer: for an exchange payment, the sender isn't the user.

---

## 8. Other Mesh features (not used in the PoC)

| Feature | What it does |
|---|---|
| **Deposits** (`TRANSFER_TYPE_DEPOSIT`) | The user picks the amount |
| **Wallet verification** (`verificationOptions`) | The user signs a message, or sends a test amount, to prove they control an address |
| **Pay links** (`generatePayLink`) | A hosted payment page. Not available yet |
| **Fiat ramps** (`/v2/ramp/*`) | Buy or sell crypto for fiat |
| **Custom UI** | Driving the session API ourselves instead of embedding Link. Self-supported |

---

## 9. Sandbox

- **Exchanges** are mocks (for example `mock_coinbase`). **No real assets move**, so an exchange transfer never reaches a testnet contract. Sandbox webhooks fire on the same events, with synthesized data.
- **Wallets** use public testnets: Ethereum Sepolia (`eip155:11155111`), Base Sepolia (`eip155:84532`) and Solana Devnet. Each transfer is a real testnet transaction.
- **Native tokens only:** the docs list each testnet with its **native token only** (Sepolia: ETH). Session creation accepts PYUSD, USDG and USDC on Sepolia, but whether Link offers an ERC-20 transfer is checked in the plan's I1.
- **Test users:** `userId` values such as `user_test_happy_path` and `user_test_insufficient_balance` trigger fixed outcomes. The docs say to confirm the exact ids per account.
- Mesh supports Tempo only on mainnet, which is why this feature targets Ethereum.

---

## 10. How this maps onto InvoiceDiscount

| Mesh concept | InvoiceDiscount |
|---|---|
| `toAddresses[0].address` | The invoice clone. Each invoice has its own address, so attribution needs no memo |
| `toAddresses[0].amount` | The quoted discounted amount (spec §4.2), in token units |
| `TRANSFER_TYPE_PAYMENT` | Pay now: a fixed amount for this invoice |
| `clientTransactionId` | Maps webhooks back to an invoice payment session |
| `transfer.completed` webhook | The trigger to re-check the clone's balance and call `settleDirect()` |
| `source.crypto.venue` / `.address` | Shown off-chain as the payer |
| Session's ~1 h life | Not the quote's life: the quote expires after 10 minutes (spec §4.2) |

Mesh only gets the money into the clone. The contract still decides whether the invoice is paid, and `settleDirect()` checks the amount itself. A wrong or forged webhook can therefore at worst trigger a `settleDirect()` call that reverts.
