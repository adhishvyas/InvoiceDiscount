# How Mesh Works: APIs and Integration

> An explainer for the Pay with Mesh feature ([`../spec/mesh-pay-now-spec.md`](../spec/mesh-pay-now-spec.md)). Based on the Mesh docs at [docs.meshconnect.com](https://docs.meshconnect.com), read October 2026.

---

## 1. What Mesh is

Mesh (meshconnect.com, also sold as MeshPay) is a **crypto payments network**. It lets a user pay from accounts they already have, such as an exchange account (Coinbase, Binance, Robinhood, Uphold, Cash App, OKX Pay and others) or a self-custody wallet (MetaMask, Phantom, Rainbow, Ledger, and 300+ WalletConnect wallets), without our app integrating each one.

Mesh handles the parts that differ for every source: logins, MFA, OAuth, wallet connections, choosing the network, previewing fees, compliance checks, and the transfer itself. We tell Mesh *where the money should go and how much*, and Mesh gets it there.

The thing to understand: **Mesh doesn't hold the money in between.** The transfer goes on-chain from the user's account straight to the address we give. For us, that's the invoice clone.

---

## 2. The three parties

Every integration has the same three parties:

```
   OUR SERVER                     OUR FRONTEND                        MESH
  (mesh-server)                 (browser, Link SDK)          (API + hosted Link UI)
       │                                │                              │
       │◄──── 1. "pay invoice 0x…" ─────│                              │
       │──── 2. POST /api/v1/linktoken ─┼─────────────────────────────►│
       │◄───────────────────────────────┼──────────── linkToken ───────│
       │───── 3. linkToken ────────────►│                              │
       │                                │── 4. openLink(linkToken) ───►│  user connects
       │                                │                              │  Coinbase / MetaMask,
       │                                │                              │  approves transfer
       │                                │◄── 5. onTransferFinished ────│
       │                                │                              │── 6. transfer ──► chain
       │◄───────────────────────────────┼──── 7. webhook: Succeeded ───│
       │── 8. settleDirect() ───────────┼──────────────────────────────┼───────────────► chain
```

| Party | Does | Holds |
|---|---|---|
| **Our server** | Creates sessions (Link Tokens), receives webhooks, makes business decisions | Mesh API key, webhook secret |
| **Our frontend** | Shows a button, opens Link, reacts to callbacks | Only the short-lived Link Token |
| **Mesh** | Runs the whole user journey and the transfer, then reports the outcome | The user's connections |

---

## 3. Environments and authentication

| | Sandbox | Production |
|---|---|---|
| Base URL | `https://sandbox-integration-api.meshconnect.com` | `https://integration-api.meshconnect.com` |
| API key prefix | `sk_sandbox_…` | production key |
| Funds | Simulated exchanges, plus real **testnet** wallet transfers | Real |

Every API call sends two headers:

```
X-Client-Id:     <our Mesh Client ID>
X-Client-Secret: <our API key>
```

Because the secret is in every request, **all Mesh API calls are made server-side**. The browser never sees the key.

Access is invite-only. A Mesh representative invites us to the **dashboard**, where we:

- create API keys (Read & Write permissions are needed for transfers)
- add **Allowed domains**. Link refuses to render on any other origin, so `localhost:<port>` must be listed for development
- register **one webhook URL per environment**, and store its signing secret, which is shown only once

---

## 4. The Link Token: configuring a session

Every user session starts with `POST /api/v1/linktoken` from our server. The request body sets up everything the user will see. The response contains a `linkToken`.

- It is **single-use** and **expires after 10 minutes**. We request a new one for every attempt.
- It encodes the configuration, so the client can't change the destination or amount.

The fields that matter for paying an invoice:

```jsonc
{
  "userId": "buyer-7f3a…",            // stable, non-PII id for the user (max 300 chars)
  "restrictMultipleAccounts": true,   // standard for transfer flows
  "transferOptions": {
    "transferType": "payment",        // deposit | payment | onramp | withdrawal
    "transactionId": "inv-0xabc…-s1", // our id; echoed back in callbacks and webhooks
    "isInclusiveFeeEnabled": false,   // false: fees on top, the destination gets the full amount
    "generatePayLink": false,         // true: also return a hosted URL instead of using the SDK
    "toAddresses": [
      {
        "networkId": "<Mesh network UUID>",  // from GET /api/v1/transfers/managed/networks
        "symbol": "PYUSD",
        "address": "0x<invoice clone>",
        "amount": 9450.00                    // required for payment, in token units
      }
    ]
  }
}
```

### Transfer types

| Type | User experience | Amount |
|---|---|---|
| `deposit` | "Deposit to your account" | The user chooses (optional `minAmount`) |
| `payment` | "Pay this merchant" | **Fixed** per destination (`amount` required) |
| `onramp` | Buy crypto with fiat, delivered to our address | Usually `amountInFiat` |
| `withdrawal` | Mesh-hosted payout *from* us to the user (uses `fromPairs`) | Up to `maxAmount` |
| verify | The user signs a message to prove they own a wallet (`verifyWalletOptions`) | none |

`toAddresses` is an array. A merchant usually lists every network/token pair it can receive, such as USDC on Ethereum, Base and Solana, so Mesh can pick whichever the user holds. We list a single entry because each invoice accepts one token on one network.

Networks and tokens are identified by **Mesh UUIDs**, not chain IDs. They don't change, so they can be looked up once (`GET /api/v1/transfers/managed/networks`, `GET …/tokens`) and kept in configuration.

---

## 5. The Link SDK: the user journey

The web SDK is `@meshconnect/web-link-sdk`. SDKs also exist for iOS, Android, React Native and Flutter.

```ts
import { createLink } from '@meshconnect/web-link-sdk';

const link = createLink({
  renderType: 'overlay',        // or 'embedded' (an iframe in our container, min 500px high)
  theme: 'system',
  language: 'system',
  displayFiatCurrency: 'USD',
  onIntegrationConnected: (p) => {},  // user connected an exchange/wallet
  onTransferFinished:     (p) => {},  // transfer submitted
  onExit:                 (p) => {},  // Link closed, for any reason
  onEvent:                (e) => {},  // fine-grained events (analytics, UX)
});

link.openLink(linkToken);
```

Inside Link the user:

1. Picks a source from Mesh's catalog: an exchange, a wallet, or **manual deposit** (a QR code or copy-paste address, offered by default if a direct connection fails).
2. Logs in. For an exchange this includes MFA. For a wallet, they connect it.
3. Sees a **preview** with the amount, network and fees.
4. Approves. For an exchange, Mesh asks the exchange to withdraw to our address. For a wallet, the user signs the transaction in the wallet.

### Callbacks

| Callback | Fires when | Useful fields |
|---|---|---|
| `onIntegrationConnected` | An account is connected | `accessToken` (holds a `tokenId` for return users, §8) |
| `onTransferFinished` | The provider **acknowledged** the transfer | `status` (pending/succeeded/failed), `transferId`, `transactionId`, `txHash`, `amount`, `symbol`, `fromAddress`, `toAddress`, `refundAddress`, `networkName` |
| `onExit` | Link closes | `summary.page` (how far the user got), `errorMessage` |
| `onEvent` | Steps along the way | event `type` and payload |

> **`onTransferFinished` is not confirmation.** It means the exchange or wallet accepted the request, not that funds arrived. A `pending` transfer can still fail. Use callbacks only to update the UI.

---

## 6. Webhooks: the source of truth

Mesh POSTs JSON to our registered URL each time a transfer's status changes. This is server-to-server, so it arrives even if the user has closed the tab.

### Statuses

| Status | Meaning |
|---|---|
| `Pending` | Started, not final. It may or may not have a `TxHash` yet. **Not guaranteed**: manual deposits and sandbox may skip it |
| `Succeeded` | Final. The funds were delivered to the destination, and `TxHash` is set |
| `Failed` | Final. There is no `TxHash` |
| `RefundPending` / `RefundSucceeded` | Ramp and bridging refund flows only |

### Payload (single-step transfer)

```json
{
  "Id": "358c6ab7-…",            // this delivery attempt (changes on retry)
  "EventId": "56713e70-…",       // the event (stable across retries) → idempotency key
  "SentTimestamp": 1720532648,
  "UserId": "buyer-7f3a…",
  "TransactionId": "inv-0xabc…-s1",
  "TransferId": "dd4063e5-…",    // Mesh's id for the transfer
  "TransferStatus": "Succeeded",
  "TxHash": "0x7d4e…",
  "Chain": "Ethereum",
  "Token": "PYUSD",
  "DestinationAddress": "0x<invoice clone>",
  "SourceAccountProvider": "Coinbase",
  "SourceAmount": 9450.0,
  "DestinationAmount": 9450.0,
  "SourceAddress": "0x…",        // who posted it on-chain (an exchange hot wallet for exchanges)
  "RefundAddress": "0x…",        // where funds could go back to the user
  "Timestamp": 1715175519038
}
```

Multi-step transfers (a bridge or a swap) add a `TransferSteps` array with one entry per on-chain leg. The top-level `Chain`, `Token` and `DestinationAmount` then describe what *arrived*.

### Handling rules

1. **Verify the signature.** Compute HMAC-SHA256 of the **raw request body** with the webhook secret, Base64-encode it, and compare it with the `X-Mesh-Signature-256` header. Never parse and re-serialize the JSON first, because that changes the bytes. Optionally also check that the sender is Mesh's IP, `20.22.113.37`.
2. **Reply `200` within 200 ms**, then do the work in the background.
3. **Expect duplicates.** Delivery is at-least-once, so deduplicate on `EventId`.
4. **Match on `TransactionId`**, the id we set in the Link Token.

### Polling as a backup

`GET /api/v1/transfers/managed/mesh` lists transfers. It can be filtered by `ClientTransactionId` (our `transactionId`), `UserId`, `Statuses` and a time range. It's useful for reconciliation or for catching up on a missed webhook, but Mesh recommends webhooks over polling.

---

## 7. Refund address and payer identity

Each transfer reports two addresses that look alike but differ:

- **`SourceAddress`**: the address that sent the transaction on-chain. For an exchange this is the exchange's **omnibus hot wallet**, shared by many users.
- **`RefundAddress`**: an address that reaches *this user*. For a wallet it's the wallet itself. For an exchange it's the user's own deposit address at that exchange.

To send money back to a payer, use `RefundAddress`, never `SourceAddress`. This is also why our contract can't learn the payer from the inbound transfer: for an exchange payment, the sender isn't the user.

---

## 8. Other Mesh features (not used in the PoC)

| Feature | What it does |
|---|---|
| **Mesh Managed Tokens (MMT)** | Store the `tokenId` from `onIntegrationConnected` and pass it as `accessTokens` next time. The user skips logging in and pays in one or two taps. Mesh refreshes the tokens |
| **Paylinks** | `generatePayLink: true` returns a hosted URL as well as the token, so Link can open in its own page with no SDK |
| **SmartFunding** | Picks the best source asset or account automatically, and can swap or bridge so the user pays with what they hold |
| **Headless bridging** | API-only (`/api/v1/bridging/*`): discover routes, quote, and create a one-time address that bridges any pay-in to our destination. **Mainnet only**, and enabled per client by Mesh |
| **Onramp** | The user buys crypto with fiat through a provider (e.g. Binance Connect), delivered to our address |
| **Wallet verification** | The user signs a message to prove they control an address |
| **Sub-clients** | Child accounts for platforms that serve many merchants |

---

## 9. Sandbox

- **Exchanges** are simulated. Coinbase and a legacy Binance integration are available. All test accounts use password `Pass123` and OTP `123456`, and the username picks the scenario: `Mesh` is a full portfolio, `Mesh2` is empty, `MeshUSDC` holds only USDC, and so on. **No real assets move**, so an exchange transfer in sandbox never reaches a testnet contract.
- **Wallets** use real testnets: MetaMask on Sepolia and Base Sepolia, Rainbow on Sepolia, and Phantom on Solana Devnet. Sepolia stablecoins are **PYUSD** and **USDG**. These transfers are real on-chain events.
- **Networks:** Mesh supports Tempo only on mainnet. Its sandbox has no Tempo testnet. That is why this feature targets Ethereum.
- `Pending` webhooks may be skipped.

---

## 10. How this maps onto InvoiceDiscount

| Mesh concept | InvoiceDiscount |
|---|---|
| `toAddresses[0].address` | The invoice clone. Each invoice has its own address, so attribution needs no memo |
| `toAddresses[0].amount` | The quoted discounted amount (spec §4.2) |
| `transferType: "payment"` | Pay now: a fixed amount for this invoice |
| `transactionId` | Maps webhooks back to an invoice payment session |
| `Succeeded` webhook | The trigger to re-check the clone's balance and call `settleDirect()` |
| `RefundAddress` | Shown off-chain as the payer. Kept for any future refund or rescue |
| Link Token's 10-minute expiry | Sets the minimum length of the quote window |

Mesh only gets the money into the clone. The contract still decides whether the invoice is paid, and `settleDirect()` checks the amount itself. A wrong or forged webhook can therefore at worst trigger a `settleDirect()` call that reverts.
