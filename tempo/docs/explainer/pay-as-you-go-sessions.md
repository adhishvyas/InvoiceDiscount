# Tempo Pay-As-You-Go: Sessions and Vouchers

> Part of the Tempo explainers. See [`tempo-primer.md`](./tempo-primer.md) and [`tempo-how-it-works.md`](./tempo-how-it-works.md).
>
> **Status (October 2026): live on mainnet.** Sessions run on the TIP-1034 channel reserve precompile, introduced in protocol version T5. This explainer covers the current TIP-1034 Sessions, not the Legacy Sessions that `mppx` 0.13.0 removed.

---

## 1. The problem sessions solve

MPP's simplest payment is a **charge**: one request, one on-chain transfer. That works for a $50 invoice. It doesn't work for an LLM API that bills $0.000025 per token, because:
- one on-chain transaction per token is far too slow (even at ~500ms finality) and too expensive
- the total cost isn't known when the request starts
- billing after the fact means the server takes on credit risk, while prepaid credits make the client guess its usage and lose what's left over

A **session** fixes this with a **unidirectional payment channel**: one on-chain deposit up front, then any number of **off-chain signed vouchers** as usage happens, and one on-chain settlement at the end (or a few along the way).

## 2. The mental model: a bar tab with a card on file

```
  CLIENT (payer)                         SERVER (payee)                    TEMPO
       │                                      │                              │
       │── open(deposit = 1.00) ──────────────┼─────────────────────────────►│  funds move into
       │                                      │                              │  the channel reserve
       │── open credential ──────────────────►│── verify deposit on-chain ──►│
       │                                      │                              │
       │── request #1 + voucher(total 0.01) ─►│  check signature (~µs)       │
       │◄─────────────────────── 200 + data ──│  no chain call               │
       │── request #2 + voucher(total 0.02) ─►│                              │
       │◄─────────────────────── 200 + data ──│                              │
       │            ...                       │                              │
       │                                      │── settle(voucher 0.20) ─────►│  0.20 → payee
       │            ...                       │                              │
       │── close credential ─────────────────►│── close(voucher 0.37) ──────►│  0.17 → payee
       │                                      │                              │  0.63 → payer (refund)
```

- The **deposit** is the card on file. It's the most the channel can ever pay out.
- Each **voucher** is the client signing the tab: "the total so far is X."
- The server can **cash in** the latest signed total whenever it wants, and must give back whatever wasn't used when the tab closes.

## 3. The lifecycle

### Open

The client calls `open` on the channel reserve precompile at `0x4D50500000000000000000000000000000000000` (the prefix spells "MPP" in ASCII). The deposit moves out of the payer's wallet through a native system transfer, so there is **no separate `approve` step**. This works the same way for passkey accounts.

The channel is described by a `ChannelDescriptor`:

```solidity
struct ChannelDescriptor {
    address payer;             // who deposits and pays
    address payee;             // who gets paid
    address operator;          // optional: may settle/close on the payee's behalf (0 = payee only)
    address token;             // the TIP-20 stablecoin
    bytes32 salt;              // lets the same pair open several channels
    address authorizedSigner;  // optional: a different key that signs vouchers (0 = payer signs)
    bytes32 expiringNonceHash; // replay-protected hash of the open transaction
}
```

The `channelId` is `keccak256` of all of these fields plus the precompile address and chain ID. Because `expiringNonceHash` comes from the open transaction itself, **every channel ever opened gets a unique ID**, even if you reopen the "same" channel later.

On-chain, the precompile stores only **one 32-byte slot** per channel:

```solidity
struct ChannelState {
    uint96 settled;           // how much the payee has already been paid
    uint96 deposit;           // how much the payer has locked in
    uint32 closeRequestedAt;  // 0 = active; otherwise the time the payer asked to close
}
```

The descriptor isn't stored. It's emitted in the `ChannelOpened` event, and every later call has to pass it in again so the precompile can recompute the `channelId`.

### Session (vouchers)

The client signs a voucher for each unit it consumes. See [§4](#4-the-voucher-mechanism-in-depth).

### Settle (optional, any time)

The payee (or operator) submits the highest voucher it holds. The precompile checks the signature, pays the payee `cumulativeAmount − settled`, and sets `settled = cumulativeAmount`. **The channel stays open.** Servers do this to cut their exposure on long sessions. In `mppx` it's driven by a server-side `settlementSchedule` (by amount, by metered units, or by time) or by calling `tempo.session.settle` / `settleBatch` yourself.

### Top up

If the deposit runs low, the payer calls `topUp` to add more without closing. If the payer had requested a close, topping up **cancels that close request** (it resets `closeRequestedAt` to 0).

### Close: the cooperative path

The client sends the server a **close credential** with its latest voucher plus a separate `closeSignature` that authorizes closing. The server calls `close` on-chain, and the precompile:
1. pays the payee `captureAmount − settled`
2. refunds `deposit − captureAmount` to the payer
3. deletes the channel's storage slot

`close` takes a `captureAmount` as well as the voucher, with the rule `settled ≤ captureAmount ≤ cumulativeAmount` and `captureAmount ≤ deposit`. The payee can charge **less** than the voucher authorizes but never more, and never more than the deposit.

### Close: the payer's exit if the server disappears

The payer **can't** call `close` (only the payee or operator can). Instead:
1. The payer calls `requestClose`, which records `closeRequestedAt = now`.
2. A **15-minute grace period** (`CLOSE_GRACE_PERIOD`) starts. During it, the payee can still `settle` or `close` with the vouchers it holds.
3. After the grace period, the payer calls `withdraw` and gets back everything that hasn't been settled.

So the payer's money is never stuck forever. The payee, though, **has to watch for close requests**. Any voucher it hasn't settled by the end of the grace period is lost to it.

## 4. The voucher mechanism in depth

### What a voucher is

A voucher is an **EIP-712 typed-data signature** over just two fields:

```
Voucher(bytes32 channelId, uint96 cumulativeAmount)
```

That's all of it. There's no nonce, no expiry and no per-request ID. It means: *"On channel `channelId`, I authorize the payee to take up to `cumulativeAmount` in total."*

Signatures are checked through Tempo's signature-verification precompile (TIP-1020, at `0x5165…0000`), so a voucher can use **any Tempo signature type** that TIP-1020 supports. There's one exception: **keychain-wrapped signatures (`0x03` / `0x04`) are rejected**. To have a different key sign vouchers, set `authorizedSigner` in the descriptor when the channel opens. Don't try to sign through an access-key wrapper around the payer.

### Why "cumulative" rather than "pay 0.01 now"

This is the key design choice. Each voucher states the **running total**, not the increment:

| Request | Voucher says | Server grants access for |
|---|---|---|
| #1 | total = 0.01 | 0.01 − 0.00 = 0.01 |
| #2 | total = 0.02 | 0.02 − 0.01 = 0.01 |
| #3 | total = 0.03 | 0.03 − 0.02 = 0.01 |

Consequences:

1. **Only the latest voucher matters.** A voucher for 0.03 covers everything up to it. The server stores just one signature per channel, the highest one, and can throw the rest away.
2. **Replay is harmless.** Sending the 0.02 voucher again changes nothing, since the server needs the total to go **up** and `settled` on-chain only ever increases. That's why no nonce is needed.
3. **Lost messages are harmless.** If voucher #2 never arrives but #3 does, the server still holds a valid claim for the full 0.03.
4. **Settlement is O(1).** One `settle` call with the highest voucher replaces thousands of micro-transfers.
5. **It's bound to one channel.** `channelId` is in the signed data, and the ID includes the chain ID and precompile address, so a voucher can't be replayed on another channel or another network.

### What the server checks per request

For each incoming voucher, the server (in `mppx`, `tempo.session`):
1. recovers the signer from the EIP-712 signature and checks it's the channel's `authorizedSigner` (or `payer` if none is set)
2. checks `cumulativeAmount` is **greater** than the highest voucher it has already accepted
3. checks the increase covers the price of what's being requested
4. checks the total doesn't exceed the deposit it saw on-chain
5. atomically saves the new highest voucher, then serves the response

**None of this touches the blockchain.** It's a signature recovery and a comparison, measured in microseconds, which is why billing per LLM token is practical. (This is also why the server's channel store needs an atomic `update`: two server instances must not both accept the same increment.)

### Why the server doesn't have to trust the client's total

The total in a voucher isn't a usage report that the server has to believe. It's a **signed promise to pay**, and the server checks it against two things the client can't fake.

**1. The server keeps its own count.** The server does the metering: it knows how many photos it served or tokens it streamed. It stores the highest voucher it has accepted for each channel and requires:

```
new.cumulativeAmount  ≥  lastAccepted.cumulativeAmount + price of this request
```

If the client sends a total that's too low (say it pays for 10 photos after getting 20), the check fails. The server refuses with another `402` and serves nothing. If the client sends *more* than it owes, it has simply authorized the server to take more, which only hurts the client.

**2. The chain guarantees the money is there.**
- **The deposit:** the server checked it on-chain when the session opened.
- **The signature:** it proves the payer (or its `authorizedSigner`) signed this exact total for this exact channel.
- **The client can't pull the deposit out quietly.** Only the payee or operator can `close`. The payer's own exit is `requestClose`, which shows up on-chain and then waits out the 15-minute grace period. The server watches for it and settles with its best voucher before the time runs out.
- **The precompile enforces the rules:** `settled` only ever goes up, and it can never exceed `deposit`.

A valid voucher is therefore as good as money: the funds are locked, the client signed for them, and the server can claim them whenever it wants. The server trusts **its own meter for how much was used**, and **the signature plus the locked deposit for whether it gets paid**. It never takes the client's word on usage.

### Voucher above the deposit

The precompile treats a voucher with `cumulativeAmount > deposit` as a **validly signed** voucher. `settle` still rejects it, and `close` can only capture up to `deposit`. A client that signs past its deposit hasn't created a debt. The server just can't collect more than is locked.

## 5. Worked example

Photo API at $0.01 per photo; the client sets `maxDeposit: '1'` (1 OUSD).

| Step | On-chain? | `deposit` | `settled` | Highest voucher | Payer wallet | Payee wallet |
|---|---|---|---|---|---|---|
| Open with 1.00 | yes | 1.00 | 0.00 | — | −1.00 | 0 |
| Photos 1–20 | no | 1.00 | 0.00 | 0.20 | — | — |
| Server settles | yes | 1.00 | 0.20 | 0.20 | — | +0.20 |
| Photos 21–37 | no | 1.00 | 0.20 | 0.37 | — | — |
| Cooperative close at 0.37 | yes | (deleted) | (deleted) | — | +0.63 | +0.17 |

**Net:** the payer spent 0.37 and the payee received 0.37. Three on-chain transactions paid for 37 requests. With a larger deposit, the same three transactions could cover thousands.

## 6. Who risks what

| Party | Worst case | Why it's bounded |
|---|---|---|
| **Payer** | Loses the amount on its latest signed voucher | The precompile won't pay out more than a validly signed voucher authorizes. The rest comes back through `close`, or through `requestClose` + `withdraw` after 15 minutes. |
| **Payer** | Deposit locked while the channel is open | Only the deposit is locked, not the whole wallet. Keep `maxDeposit` small. |
| **Payee** | Serves one unit without getting paid | The server checks the voucher *before* serving, so at most the in-flight unit is at risk. |
| **Payee** | Loses unsettled vouchers | Only if the payer requests a close and the payee doesn't settle within the 15-minute grace period. Watch for close requests and settle regularly. |
| **Payee** | Two server instances both accept the same voucher, serving two requests for one payment | The channel store must have an atomic `update(key, fn)` across all instances, so only one can accept a given increase. The Redis, Upstash and Cloudflare adapters don't add atomicity themselves. |
| **Payee** | The client signs vouchers for more than it deposited | Such a voucher is validly signed, but the precompile only pays out up to `deposit`. The server checks the total against the deposit before accepting, so it never serves against money that isn't locked. |

Neither side has to trust the other with more than the deposit.

## 7. Using it with `mppx`

**Server:** wrap a route with `mppx.session({ amount: '0.01', unitType: 'photo' })`. The handler only runs once a valid voucher has been accepted.

**Client:** create the `tempo` method with an `account` and `maxDeposit`. The client opens the channel on the first `402`, then signs vouchers automatically on later requests. Channels **don't close automatically**. To get the refund, use `tempo.session.manager({ account, maxDeposit })` and call `.close()`. The manager also has `.topUp()`, `.sse()` and `.ws()` for streams. Pass a `channelStore` so a reload or restart picks up the existing channel instead of opening a new one.

**Receipts:** a session receipt's `reference` is the **channel ID**, not a transaction hash. The settlement `txHash` exists only after close.

**Gas:** servers can sponsor the client's channel transactions. Since T7, a payer that closes a channel gets a storage credit that makes its next `open` cheaper (60,225 gas on the credited path).

## 8. Relevance to InvoiceDiscount

**Sessions are the wrong tool for paying an invoice.** An invoice is one known amount paid once. A session would lock a deposit, need a close step, and add a 15-minute exit path, all for a single voucher. MPP's `charge` intent (one on-chain transfer, nothing locked) fits the Pay Now flow.

Where the voucher model *is* worth remembering: anything metered, such as a pay-per-query data feed for invoice verification. The cumulative-voucher pattern (sign the running total, keep only the highest, settle once) is also a good design to borrow for any off-chain authorization we build.

## Sources

- [Accept pay-as-you-go payments (Tempo guide)](https://tempo.xyz/developers/docs/guide/machine-payments/pay-as-you-go)
- [MPP Tempo Sessions reference](https://mpp.dev/payment-methods/tempo/session) · [Session intent](https://mpp.dev/intents/session)
- [TIP-1034: TIP-20 Channel Reserve Precompile](https://tips.sh/1034) (descriptor, packed state, voucher type, execution rules, grace period, invariants)
- [T7 network upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t7) (channel storage credits)
