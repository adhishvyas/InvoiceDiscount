# How Tempo Works: A Technical Deep Dive

> Companion to [`tempo-primer.md`](./tempo-primer.md), which covers what Tempo is, how it compares to other chains, and its tooling. This file covers the mechanics. Privacy has its own file: [`tempo-zones.md`](./tempo-zones.md).
>
> Sources are the Tempo docs (`tempo.xyz/developers`) and Commonware's Simplex documentation, read in October 2026. A sentence marked *(inference)* is my own reasoning from those sources, not something the docs state.

**Contents**

1. [Consensus: Simplex BFT](#1-consensus-simplex-bft)
2. [Leader selection with a VRF](#2-leader-selection-with-a-vrf)
3. [Finality: why there are no reorgs](#3-finality-why-there-are-no-reorgs)
4. [Why the blocks are so fast](#4-why-the-blocks-are-so-fast)
5. [Protocol-level stablecoins: TIP-20 in depth](#5-protocol-level-stablecoins-tip-20-in-depth)
6. [pathUSD and the quote-token tree](#6-pathusd-and-the-quote-token-tree)
7. [Fees without a native token](#7-fees-without-a-native-token)
8. [2D nonces (and expiring nonces)](#8-2d-nonces-and-expiring-nonces)
9. [Payment lanes](#9-payment-lanes)

---

## 1. Consensus: Simplex BFT

### The family it belongs to

Blockchains reach agreement in one of two broad ways:

- **Longest-chain / fork-choice consensus** (Bitcoin, and Ethereum's LMD-GHOST layer). Anyone can extend the chain. Forks happen, and a fork-choice rule picks the winner. A block is only "probably final", and the probability grows with every block built on top of it.
- **BFT (Byzantine Fault Tolerant) voting consensus** (Tendermint/CometBFT, HotStuff, Stellar's SCP in spirit, and **Simplex**). A known set of validators *votes* on each block. Once a supermajority signs, the block is final, and that is a mathematical guarantee, not a probability.

Simplex belongs to the second family. Tempo uses the implementation by **Commonware** (a Rust library of blockchain building blocks).

### The 3f+1 rule

BFT protocols assume a committee of `n = 3f + 1` validators, of whom at most `f` are *Byzantine*. Byzantine means arbitrarily faulty: crashed, buggy or actively malicious. A **quorum** is `2f + 1` votes. With 4 validators the network tolerates 1 bad one, and with 10 it tolerates 3.

| Condition | Result |
|---|---|
| Fewer than ⅓ Byzantine | **Safety**: two conflicting blocks can never both be finalized |
| At least ⅔ honest *and online* | **Liveness**: the chain keeps making progress |
| More than ⅓ offline | The chain **halts** (and resumes when they come back). It never forks |

Tempo explicitly **prefers halting to forking**. For a payments chain that's the right call: a short outage is recoverable, but a double-spend isn't.

### How do we know `f`, and who is faulty?

**Short answer: we don't, and we don't need to.** Nobody works out at runtime which validators are faulty, and `f` isn't measured. `f` is a number calculated from the size of the validator set. The protocol is built so that safety holds no matter which validators are the bad ones, as long as there are at most `f` of them.

**Where `n` and `f` come from:**

- **`n` is public.** The validator set is recorded on-chain, and every validator knows exactly who is in the committee for the current epoch (about 3 hours). Changes take effect two epochs after they're made on-chain.
- **`f` is derived from `n`:** `f = ⌊(n − 1) / 3⌋`. It means "the most validators that can be faulty while the protocol stays safe". It's a design assumption, not something anyone observes.
- **The quorum is set from that.** It's `2f + 1` when `n = 3f + 1`; more generally it's `n − f`.
- **In Tempo, the threshold is fixed into the keys.** The key-generation (DKG) ceremony each epoch creates the shared signing key so that a certificate needs exactly a quorum of partial signatures. The threshold isn't a setting someone adjusts while the chain runs.

Adding validators only helps when you reach the next `3f + 1`:

| n | f tolerated | Quorum (n − f) |
|---|---|---|
| 4 | 1 | 3 |
| 5 | 1 | 4 |
| 6 | 1 | 5 |
| 7 | 2 | 5 |
| 10 | 3 | 7 |

With 5 validators the quorum has to rise to 4. Otherwise two quorums of 3 could overlap in just 1 validator, and that one could be the faulty one.

**Why you don't need to identify the bad validators.** The guarantee depends only on how many are faulty, not which ones:

- **Safety.** Any two quorums share at least `f + 1` validators. With at most `f` bad ones, at least one shared validator is honest. An honest validator never signs two conflicting finalize votes, so two conflicting blocks can't both be finalized. That works for every possible choice of which `f` validators are bad. (The full argument is in [§3](#3-finality-why-there-are-no-reorgs).)
- **Liveness.** A quorum needs only `n − f` votes, so up to `f` validators can be silent or crashed and the honest ones still reach quorum. A bad leader is handled by timeouts and nullify votes: the view is skipped and the next random leader takes over. Nobody has to decide whether the leader was malicious or just offline. Those look the same from outside, and the protocol treats them the same.

So the protocol doesn't track "who is bad". Every step just waits until it has enough matching signatures, and the arithmetic guarantees that enough will always include an honest validator.

**What happens if the assumption is wrong:**

- **More than `f` offline** (crashed, or deliberately not voting): no quorum can form, so the chain **halts**. Nothing already final is undone, and it resumes when enough come back.
- **More than `f` actively malicious and colluding:** in theory they could finalize conflicting blocks. That's the trust assumption you accept with any BFT chain, which is why *who* the validators are matters.

**Can misbehavior be detected at all?** Some of it can, after the fact:

- **Provable misbehavior.** If a validator signs two conflicting votes in the same view, those two signatures are cryptographic proof against it. Commonware's Simplex implementation reports this kind of evidence: conflicting notarize votes, conflicting finalize votes, or nullifying a view and also finalizing in it. *(From general knowledge of Commonware's design; not verified against its current API.)*
- **Non-provable misbehavior.** Being slow, offline, or quietly censoring transactions as leader can't be distinguished from network problems. It shows up only in monitoring, such as missed votes or proposals.

**What happens to a misbehaving validator?** On Ethereum, provable misbehavior gets a validator's stake **slashed**. Tempo has no native token and so no stake to slash, and the docs don't describe any slashing. In a permissioned set the accountability is **off-chain**: the validators are known organisations, and a misbehaving one can be removed from the on-chain validator set, taking effect two epochs later. That's the same model as Stellar, where trust rests on who the validators are rather than on money at stake.

### How one round ("view") works

Simplex proceeds in numbered **views**. Each view has one **leader**. Every validator runs two timers per view: one waiting for the leader's proposal, and one bounding the whole view.

```
View v
 ┌─────────────────────────────────────────────────────────────────────┐
 │ 1. PROPOSE   Leader broadcasts block B (built on a notarized parent) │
 │                                                                      │
 │ 2. NOTARIZE  Each validator checks B; if valid, broadcasts           │
 │              notarize(B, v)                                          │
 │                                                                      │
 │    ── 2f+1 notarize votes ──► NOTARIZATION certificate for B          │
 │              • validators immediately move on to view v+1            │
 │              • and also broadcast finalize(B, v)                     │
 │                                                                      │
 │ 3. FINALIZE  ── 2f+1 finalize votes ──► FINALIZATION certificate      │
 │              B (and every ancestor) is now final, forever.           │
 │                                                                      │
 │ ✗ TIMEOUT    If the leader is slow, offline or malicious, the timers │
 │              fire and validators broadcast nullify(v).               │
 │              2f+1 nullify ──► NULLIFICATION certificate: view v is   │
 │              skipped and everyone moves on to v+1.                   │
 └─────────────────────────────────────────────────────────────────────┘
```

Key ideas:

- **Notarize** ≈ "I've seen and checked this block, and it's a valid candidate."
- **Finalize** ≈ "This block is permanent."
- **Nullify** ≈ "This view failed; skip it." This is how Simplex survives a bad leader without stalling. A leader that has been inactive for recent views gets its timer set to zero, so the network doesn't even wait for it.
- **Pipelining:** validators start the *next* view as soon as a block is **notarized**. Finalization of block `B` happens in parallel with the proposal of block `B+1`.
- Commonware advertises **2 network hops** to notarize (block time) and **3 network hops** to finalize.

### Compact certificates with threshold BLS

Rather than attaching one signature per validator, Tempo's committee signs with a **BLS12-381 threshold signature**:

- Each validator holds a **share** of a single committee private key. No one ever holds the full key.
- Any `2f+1` partial signatures combine into **one** ordinary-looking BLS signature.
- Anyone can verify it against a single public key, which Tempo calls the **network identity**.

The shares are created by a **DKG (Distributed Key Generation) ceremony** that runs **every epoch (~3 hours)**. Routine ceremonies *reshare* the key to the next committee without changing the network identity, so validators can join or leave while light clients and RPC nodes keep verifying against the same public key. A validator added on-chain in epoch `E` takes part in the ceremony in `E+1` and becomes active in `E+2`.

**Why it matters:** a finalization certificate is small, constant-size and checkable by anyone holding one public key. That makes Tempo cheap to verify from outside, for example by bridges or by nodes downloading a snapshot.

### Who the validators are

The validator set is **permissioned** today: onboarding is coordinated with the Tempo team. That's the big trust difference from Ethereum, which anyone can join by staking 32 ETH. It's similar to how Stellar's quorum slices in practice rely on well-known organizations.

---

## 2. Leader selection with a VRF

### What a VRF is

A **Verifiable Random Function** is like a hash that only the key holder can compute, but anyone can verify:

- Given a secret key and an input, it produces an output that looks random.
- It comes with a proof that anyone with the public key can check.
- It is **unique**: for a given input there is exactly one valid output, so the holder can't shop around for a favorable one.

**BLS signatures are naturally VRFs.** They are deterministic (one valid signature per message) and unpredictable without the key.

### How Tempo uses it

In Simplex's threshold-BLS mode, every `notarize(v)` or `nullify(v)` vote also carries a **partial signature over the view number `v`**. Once `2f+1` of those arrive, anyone can combine them into the **seed for view `v`**, the threshold BLS signature on `v`. Commonware's docs state:

- The seed is **unpredictable before view `v` is underway**, because no one has enough shares until a quorum votes.
- **No participant can bias it.** The threshold signature is unique, so withholding your share only delays the result; it can't change it.
- **`seed(v)` picks the leader of view `v+1`.**

So the next leader is revealed only at the last moment, and the reveal can't be manipulated.

### Why that helps against DoS

Compare a **predictable** schedule:

- **Round-robin** (e.g. "validator `v mod n` leads view `v`"). Everyone knows years in advance who leads view 1,000,000.
- **Ethereum** publishes its proposer schedule about one epoch (~6.4 min) ahead.

If an attacker knows who the next leader is, they can **flood that one machine with traffic** right before its turn. Every view they knock out gets nullified, which wastes time and can be repeated on each upcoming leader, slowing the chain to a crawl.

With VRF selection, the next leader is known only about one view (~0.5 s) ahead. There's no time to aim a DoS attack, and attacking *every* validator constantly is far more expensive. *(inference: the docs say "DoS protection" and this is the standard reasoning.)*

### Why that helps against MEV

**MEV (Maximal Extractable Value)** is profit a block producer can take by choosing which transactions go in and in what order: front-running, sandwiching swaps, back-running liquidations.

Random, last-moment leader selection helps because:

- **No one can plan around a known future proposer.** Searchers on Ethereum can make deals with an upcoming proposer, or with a builder they know will win, ahead of time. When the leader is unknown until the previous view completes, those advance arrangements are hard to set up.
- **No one can game the schedule.** A validator can't nudge the randomness to win more leader slots, for example to land on a block where a big trade is expected, because the seed is unbiasable.
- **Multi-block MEV is hard.** Controlling two consecutive blocks lets you manipulate a price in one and profit in the next. Random leaders make consecutive control a matter of luck.

*(inference: the mechanisms above are general; the docs only say "MEV resistance".)* A random leader does **not** stop the leader of the current block from reordering *that* block's transactions. Tempo's other design choices limit the opportunity rather than eliminate it: a permissioned set of accountable validators, and an enshrined stablecoin-only DEX with same-currency pairs, where price swings are tiny.

---

## 3. Finality: why there are no reorgs

### Probabilistic vs deterministic

| Chain | What "final" means |
|---|---|
| **Bitcoin** | Never strictly final. Each new block makes a reorg exponentially less likely ("6 confirmations"). |
| **Ethereum** | The head can reorg. Blocks become *finalized* by Casper FFG after ~2 epochs (~13 min). Until then you're trusting fork-choice. |
| **Solana** | "Confirmed" after a supermajority vote (~1 s), "finalized" after 31+ more confirmed slots (~13 s). |
| **Stellar** | Each ledger is final once SCP externalizes it (~5 s). There are no forks. |
| **Tempo** | Final once a **finalization certificate** exists (sub-second). There are no forks after that. |

### Why a finalized block can't be reverted

The guarantee comes from **quorum intersection**:

- A finalization certificate needs `2f+1` signatures out of `3f+1` validators.
- Any **two** sets of `2f+1` validators must share at least **`f+1`** members. (Two sets of `2f+1` total `4f+2` slots, but only `3f+1` validators exist.)
- At most `f` validators are dishonest, so **at least one honest validator is in both sets**.
- An honest validator never signs `finalize` for two conflicting blocks in the same view. It also never signs `finalize` for a view it has already voted to **nullify**.
- Therefore two conflicting finalization certificates **cannot exist** unless more than ⅓ of validators are malicious.

There is no "longest chain" rule that could later prefer a different history. The certificate *is* the proof, and nodes check it against the network identity key before accepting a block.

### What this means in practice

- **Treat finalized as settled.** You need no "wait N confirmations" logic. Query with the `finalized` block tag (`eth_getBlockByNumber("finalized")`) when you need certainty.
- **Notarized but not yet finalized** is a brief in-between state. A notarized block whose view later gets nullified can, in principle, be skipped. Normally finalization follows within about one network round, so this window is a fraction of a second. *(inference from the Simplex protocol description)*
- **The failure mode is a halt, not a reorg.** If more than ⅓ of validators go offline, blocks stop coming, and nothing already final is undone.

For InvoiceDiscount, this means the seller can treat an early-payment or payout transaction as settled within about a second.

---

## 4. Why the blocks are so fast

Tempo produces a block about every **~600 ms**: a **500 ms block-builder loop** plus network latency and validation. Several factors combine:

1. **A short protocol path.** Simplex needs just 2 message hops to notarize and move on, and 3 to finalize. There's no fixed slot clock to wait for: Ethereum's 12 s slots are a deliberate pace that gives thousands of home validators worldwide time to keep up.
2. **Pipelining.** The next block is proposed as soon as the current one is notarized; finalization overlaps with it.
3. **A small, known, professional committee.** A permissioned set of well-provisioned validators gossips far fewer messages than Ethereum's ~1M validator keys or Solana's ~1,000+ validators. *(inference)* This is the main tradeoff: speed and simplicity in exchange for decentralization.
4. **Compact threshold signatures.** Votes aggregate into one BLS signature instead of a growing list, which keeps certificates small and verification cheap.
5. **A high-performance Rust client.** The execution layer is built on **Reth** (Paradigm's Rust Ethereum client), and consensus is Commonware's Rust library.
6. **Precompiled hot paths.** Most traffic is stablecoin transfers, which run as native Rust code (TIP-20 precompiles) instead of interpreted EVM bytecode. *(inference: the docs say precompiles make token operations "much more efficient")*
7. **Ongoing latency work.** For example, TIP-1031 embeds consensus context in block headers to enable Commonware's "deferred verification", where blocks are optimistically notarized and verified in the background.

---

## 5. Protocol-level stablecoins: TIP-20 in depth

### What "protocol-level, not ordinary contracts" means

**On Ethereum**, a stablecoin is just a smart contract someone deployed. USDC is a proxy contract pointing at an implementation Circle wrote and can upgrade, and USDT has its own different code. Consequences:

- **Every token behaves slightly differently.** USDT's `transfer` historically didn't return a `bool`, some tokens charge fees on transfer, and some rebase. Integrators must audit each token or use defensive wrappers like OpenZeppelin's `SafeERC20`.
- **The chain itself knows nothing about these tokens.** To Ethereum, USDC is opaque bytecode, so the protocol can't use it for gas, can't give it priority blockspace, and can't route it in a native DEX.
- **Each call runs interpreted EVM bytecode,** which is relatively expensive.

**On Tempo**, TIP-20 tokens are **precompiles**: the token logic is written in Rust *inside the node software itself* and exposed at fixed addresses (all beginning `0x20c0…`). When you call `transfer` on any TIP-20 address, the node doesn't run bytecode; it runs its built-in token implementation against that token's storage.

You already know this pattern from **Stellar**. Classic Stellar assets are not contracts either: issuing, trustlines, authorization flags and transfers are built into the protocol, and the **Stellar Asset Contract (SAC)** is a built-in contract interface over that native logic. TIP-20 is the same idea, delivered through the EVM.

| | Ethereum ERC-20 | Tempo TIP-20 | Stellar classic asset + SAC |
|---|---|---|---|
| Where the logic lives | Issuer's bytecode | **Node software (precompile)** | Node software |
| Can the issuer change the logic? | Yes, if upgradeable | **No.** Only a Tempo network upgrade can | No |
| What the issuer controls | Everything | **Configuration only**: roles, policy, supply cap, pause, quote token, logo | Flags: auth required/revocable, clawback |
| Same behavior across tokens? | No | **Yes, guaranteed** | Yes |
| Chain-aware features | None | Fee payment, payment lanes, DEX routing, memos | Fees in XLM only, built-in DEX, memos |

**What protocol-level buys you:**

1. **Predictable integration.** Code against `ITIP20` once and every stablecoin behaves identically: no fee-on-transfer surprises and no missing return values.
2. **Native features.** The protocol trusts TIP-20 behavior, so it can let these tokens **pay gas**, classify their transfers into **payment lanes**, and route them through the **enshrined DEX**. An arbitrary ERC-20 can't safely get any of that.
3. **Efficiency.** Native code is faster and cheaper than interpreted bytecode.
4. **Easy issuance.** An issuer calls one factory function and doesn't write or audit token code.

**What it costs you:** issuers cannot add custom logic inside the token (exotic fee mechanics, rebasing, custom hooks). Tempo's guidance is to put that logic in a separate contract around the token, such as an "external lifecycle manager" for custom issuance/redemption flows.

> You *can* still deploy a plain Solidity ERC-20 on Tempo, since it's a full EVM. But that token can't pay fees, doesn't get payment-lane treatment, and can't trade on the enshrined DEX.

### Creating a TIP-20

All TIP-20s come from the **TIP-20 Factory** precompile at `0x20fc000000000000000000000000000000000000`:

```solidity
ITIP20 token = factory.createToken(
    "My Company USD",          // name
    "MCUSD",                   // symbol
    "USD",                     // currency (used for fee eligibility + DEX routing)
    ITIP20(0x20c0000000000000000000000000000000000000), // quote token (pathUSD)
    msg.sender,                // admin
    bytes32("my-unique-salt")  // salt → deterministic address
);
```

Anyone can call it. Issuance is permissionless.

### The TIP-20 interface, grouped

**Standard ERC-20:** `name`, `symbol`, `decimals` (**always 6**), `totalSupply`, `balanceOf`, `transfer`, `approve`, `allowance`, `transferFrom`. EIP-2612 `permit` (gasless approvals by signature) is also supported.

**Memos.** These attach a `bytes32` reference that is emitted in an event:
- `transferWithMemo(to, amount, memo)`
- `transferFromWithMemo(from, to, amount, memo)`
- `mintWithMemo`, `burnWithMemo`

The memo is **32 bytes, not 32 characters**. It's designed for invoice or order IDs, or a hash of a longer reference. `transferFromWithMemo` is the variant an escrow contract like ours would call to pull funds while tagging the invoice.

**Issuance and supply:** `mint`, `burn`, `supplyCap`/`setSupplyCap` (mints above the cap revert).

**Roles** (OpenZeppelin `AccessControl` style, built in):

| Role | Can |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Change policy, quote token, supply cap and logo; manage other roles |
| `ISSUER_ROLE` | Mint and burn |
| `PAUSE_ROLE` / `UNPAUSE_ROLE` | Pause or unpause the **whole token**: every holder at once (see below) |
| `BURN_BLOCKED_ROLE` | Burn funds held by an address the policy has blocked (a compliance seizure) |
| `BURN_AT_ROLE` | Burn from **any** address except a short list of protected system addresses (see below) |

**Pause is token-wide, not per-address.** `pause()` flips a single switch on the token, and while it's on, transfers revert for *every* holder. It's an emergency brake for situations like a hack, a bug or a regulatory order, not a tool for freezing one person. Approvals still work while paused: `approve` and `permit` move no tokens, so they're allowed. `burnAt` is blocked while paused.

To freeze a **single address**, the issuer uses the **TIP-403 policy** instead: they add the address to the blacklist (or remove it from the whitelist) that the token points at. Transfers from or to that address then fail, while everyone else carries on. If the issuer then needs to seize the funds, `BURN_BLOCKED_ROLE` can burn that blocked balance.

| Issuer wants to… | Ethereum (USDC) | Tempo TIP-20 | Stellar classic asset |
|---|---|---|---|
| Stop **all** transfers | `pause()` | `pause()` (`PAUSE_ROLE`) | No global switch |
| Freeze **one** address | `blacklist(addr)` | TIP-403 blacklist/whitelist policy | Revoke the account's trustline authorization (`AUTH_REVOCABLE`) |
| Seize a frozen address's funds | Not in USDC's contract (it can only freeze) | `burnBlocked` (`BURN_BLOCKED_ROLE`) | Clawback (`AUTH_CLAWBACK_ENABLED`) |

**`burnAt` and "protected" addresses.** There are three ways to burn tokens, and they differ in *whose* tokens they can destroy:

| Function | Burns from | Condition |
|---|---|---|
| `burn(amount)` | The caller's own balance | Caller has `ISSUER_ROLE` |
| `burnBlocked(from, amount)` | Someone else's balance | `from` must be **blocked** by the token's TIP-403 policy |
| `burnAt(from, amount)` | **Anyone's** balance, blocked or not | Caller has `BURN_AT_ROLE`, the token isn't paused, and `from` isn't protected |

`burnAt` (added by TIP-1006, live with the T12 upgrade) exists mainly for **bridges**. When someone bridges tokens out to another chain, the bridge contract needs to destroy them on Tempo without asking the user for an approval first (the pattern from ERC-7802's `crosschainBurn`).

A **protected address** is one of the protocol's own system contracts. These hold pooled funds that belong to many users, so the protocol refuses to let any issuer burn from them. `burnAt` reverts with `ProtectedAddress` if `from` is:
- the **Fee Manager** (`0xfeec…`), which holds fee tokens and Fee AMM liquidity
- the **Stablecoin DEX** (`0xdec0…`), which holds every open order's funds
- the **token's own address**
- the **TIP20ChannelReserve** (`0x4D50…`), which holds payment-channel deposits
- the **ReceivePolicyGuard** (`0xB10C…`), which holds diverted transfers waiting to be claimed
- any **Zone** address (Zone portals hold the backing for private ledgers)

So "unprotected" means any ordinary address: every user wallet and every regular smart contract, **including an escrow contract like ours**. Practically, an issuer that grants `BURN_AT_ROLE` can destroy tokens sitting in our escrow. That's a trust assumption about the stablecoin issuer, much like trusting that Circle won't blacklist an Ethereum escrow holding USDC.

**Compliance: TIP-403 Policy Registry.** Each token points at a `transferPolicyId` in a shared registry:
- Policy `0` = always reject, `1` = always allow, `≥ 2` = custom.
- Custom policies are **whitelists**, **blacklists**, or **compound** policies with different rules for senders, recipients and mint recipients.
- Policies are **shared**. One "KYC'd customers" whitelist can govern many tokens, and updating it updates them all.

**Receiver protection: receive policies** (added in the T6 upgrade). An account can declare which tokens and senders it accepts. A blocked transfer still *succeeds*, but the funds are diverted to a `ReceivePolicyGuard` where they can be claimed later. This stops wrong-token or unwanted deposits from landing in, for example, an exchange deposit address.

**Exchange metadata:** `currency()` (e.g. `"USD"`, `"EUR"`) and `quoteToken()`, explained in the next section.

### Gotchas when coding against TIP-20

- **6 decimals.** `1 USD = 1_000_000`. Don't assume 18.
- **No `msg.value`.** Value moves only through token calls.
- **Transfers can be blocked by policy or pause.** Your contract's `transferFrom` can revert even with a good allowance if the issuer has paused the token or blocked an address. Design your escrow's failure paths with this in mind.
- **Receive policies can divert funds.** A transfer to a recipient with a restrictive receive policy *succeeds* but doesn't arrive. That matters if your contract pays out to user addresses.

---

## 6. pathUSD and the quote-token tree

### What pathUSD is

- The **first TIP-20 ever created** on Tempo, predeployed at genesis at `0x20c0000000000000000000000000000000000000`.
- A real USD stablecoin on mainnet, **issued by Bridge** (the stablecoin company Stripe acquired) and backed 1:1 by USD reserves. It's minted by depositing USDC.e and redeemable to USDC through Bridge.
- `currency() = "USD"`, `decimals() = 6`, and `quoteToken() = address(0)`: it's the root of the tree.
- On **testnet**, the faucet hands out "pathUSD" at the **same address**, but it's play money with no relationship to the mainnet asset.

### What it's for

pathUSD is **routing infrastructure, not a consumer stablecoin.** Tempo's docs say so explicitly and recommend **OUSD** (Open USD) for holding balances and settling payments. pathUSD has three jobs:

1. **The neutral hub of the DEX.** Every USD TIP-20 chooses a **quote token**: the one other token it's paired against on the enshrined DEX. Most pair against pathUSD, so pathUSD sits at the center.
2. **The fallback fee token.** If neither the user nor the transaction specifies a fee token (and the call isn't a transfer of some other stablecoin), fees are charged in pathUSD.
3. **Neutrality.** Tempo wants to be neutral across stablecoin issuers. Making USDC, USDT or anyone's coin the universal quote token would give that issuer a privileged position in the liquidity graph, so pathUSD fills the role instead.

### The quote-token tree

Each token has exactly one quote token, so the relationships form a **tree** rooted at pathUSD:

```
                 USDX
                  │
     USDA ──── pathUSD ──── OUSD ──── USDZ
                  │
                 USDY
```

Because it's a tree, there is **exactly one path between any two stablecoins**. Swapping USDX → USDZ always routes USDX → pathUSD → OUSD → USDZ. Benefits:
- **Liquidity concentrates** on a few pairs instead of being split across every possible pair (N tokens would otherwise need up to N² pools).
- **Routing is trivial,** with no pathfinding optimization.
- **Users never hold pathUSD.** A cross-stablecoin payment routes through it atomically in one transaction.

Issuers can change their quote token in a two-step process (`setNextQuoteToken` → `completeQuoteTokenUpdate`). Market makers can pre-seed liquidity on the new pair before the switch (TIP-1001).

> **Stellar comparison:** Stellar's path payments search the order book graph for *any* route between two assets. Tempo trades that flexibility for a single guaranteed route, within one currency.

---

## 7. Fees without a native token

1. **Gas is priced in USD.** The familiar EIP-1559 fields (`max_fee_per_gas`, priority fee) are denominated in USD rather than ETH.
2. **The fee token** is chosen in this order:
   1. the `fee_token` field of a Tempo Transaction
   2. the account's default, set with `setUserToken` on the FeeManager (`0xfeec…`)
   3. for a `transfer`/`transferWithMemo` call on a USD TIP-20, that same token
   4. otherwise **pathUSD**
3. **Eligibility:** the token must be a USD-denominated TIP-20 with liquidity in the Fee AMM.
4. **Conversion:** each validator has a *preferred* fee token. If yours differs, the **Fee AMM** swaps it at a fixed rate. You pay 1.0, the validator gets 0.997, and liquidity providers earn 0.003.
5. **Sponsorship:** with a Tempo Transaction, a second party can sign as **fee payer**, so your app can pay its users' fees. No ERC-4337 paymaster is needed.
6. **Introspection:** contracts can call `getFeeToken()` on the FeeManager (TIP-1007) to see which token is paying for the current transaction.

The **Fee AMM** (fee plumbing at a fixed price) and the **Stablecoin DEX** (a real order-book market at `0xdec0…`) are separate systems. Only the DEX is for trading.

---

## 8. 2D nonces (and expiring nonces)

### The problem with Ethereum's nonce

On Ethereum, each account has **one** counter. Transaction `n` must be mined before `n+1` can be. That causes:

- **Head-of-line blocking:** if tx 5 is stuck (gas too low, or dropped), txs 6, 7 and 8 are all stuck behind it, even if they're unrelated.
- **No safe parallel submission:** a backend sending 100 payouts from one hot wallet must assign nonces carefully in sequence. One failure jams the queue.
- **Relayer headaches:** a service submitting on behalf of users must coordinate everyone's nonces.

The usual workarounds are many hot wallets, a nonce-manager service, or ERC-4337 with its own keyed nonces.

### Tempo's solution: a nonce *per key*

A Tempo Transaction carries two numbers: **`nonce_key`** and **`nonce`**. Think of it as a 2-D grid: each account has many independent counters, and `nonce_key` picks which one.

```
account 0xAbc…
  nonce_key 0  (protocol nonce) : 0,1,2,3,…   ← same as Ethereum's nonce
  nonce_key 1                   : 0,1,2,…     ← independent stream
  nonce_key 2                   : 0,1,…       ← independent stream
  …
  nonce_key 2²⁵⁶−1 (max)        : "expiring nonce" mode (see below)
```

Rules:
- **Key `0`** is the normal Ethereum-style nonce, stored in account state. Regular EVM transactions, EIP-7702 authorizations and contract creations use it.
- **Keys `1 … (2²⁵⁶−2)`** are independent sequential streams. Within a stream, order is enforced; **across streams, there is no ordering at all.** A stuck tx on key 3 doesn't block key 7.
- Keys whose top byte is `0x5b` are **reserved** for the protocol (validator sequencing).
- The extra counters live in a **Nonce precompile** at `0x4E4F4E4345000000000000000000000000000000` (that's ASCII "NONCE"). It has a `getNonce(account, nonceKey)` view and emits `NonceIncremented`. They're kept outside account state because, as the docs put it, there's "no clean way to extend account state in Reth" (explained just below).
- **Using a new key costs extra gas** the first time, because it creates a storage slot (and Tempo's storage creation is expensive; see the gas table in the primer). Reusing a few keys is cheaper than inventing a fresh key per transaction.

### Why "no clean way to extend account state in Reth"?

The docs give only that one sentence. The reasoning below is mine, from how Ethereum clients are built. *(inference)*

In Ethereum, and therefore in Reth, every account is a **fixed record of exactly four fields**:

```
Account { nonce: u64, balance: U256, storage_root: B256, code_hash: B256 }
```

That four-field shape is baked into every layer of the client:

- **The state trie.** Each account is stored as the RLP encoding of those four fields, and the state root in every block header is a hash over them. Adding a field changes every account's hash.
- **The database.** Reth stores accounts in fixed-layout tables, for example a table mapping each address to its account record.
- **The EVM.** revm, the execution engine inside Reth, loads and saves accounts using that same struct.
- **Sync, snapshots and RPC.** State sync, `eth_getProof` and the proof formats all assume the four-field account.

A 2D nonce isn't one extra number, either. It's an **unbounded map** (`nonce_key → nonce`) per account, which can't fit in a fixed-size record at all. It needs its own key-value structure, and Ethereum already has exactly that: **contract storage**. Each contract has its own storage trie, and every layer above already knows how to read it, write it, hash it, prove it and sync it.

So rather than fork Reth's core types, trie encoding, database schema and EVM (and then maintain that fork against every upstream Reth release), Tempo puts the map in the storage of a precompile at a fixed address. The only exception is key `0`, the ordinary nonce, which stays in the normal account record so standard Ethereum transactions keep working unchanged.

There's a side benefit: because the nonces are ordinary storage, contracts and RPC clients can read them with a normal `getNonce` call, and they appear in standard state proofs.

**Tempo uses the same trick elsewhere.** The fee-token preference (FeeManager), access keys (`AccountKeychain`) and TIP-20 balances are all stored in precompile storage rather than in new account fields.

### Expiring nonces: no counter at all

Setting `nonce_key = uint256.max` switches to **expiring-nonce** mode (TIP-1009):

- There is no sequence to track. The `nonce` field becomes an arbitrary discriminator.
- **`valid_before` is required** and must be in the near future. The window was 30 s originally and has been **300 s (5 min) since the T11 upgrade**.
- Replay protection comes from the protocol remembering recent transaction hashes (a buffer of 3,000,000 entries since T11) until they expire.
- A transaction that isn't included before `valid_before` simply becomes invalid. There's no stuck queue and no need for "cancel by replacing with nonce n".

In viem, set `nonceKey: 'expiring'` to send independent transactions concurrently.

### When to use which

| Situation | Use |
|---|---|
| A normal one-off user action | Key 0 (the default) |
| A backend firing many independent payouts from one account | Expiring nonces, or a small pool of keys (one per worker) |
| Several *ordered* workflows from one account (e.g. one stream per customer) | One nonce key per workflow |
| Gasless or meta-transactions submitted by a relayer | Expiring nonces |
| Things that must succeed or fail **together** | Not nonces: put them in one transaction's `calls` batch |

**Analogies:** this is the same idea as **ERC-4337's 192-bit nonce key + 64-bit sequence**, but at the protocol level. Solana sidesteps the problem differently: it has no account nonce at all and uses a recent blockhash (valid ~60–90 s) as an expiry, which resembles Tempo's expiring mode. Stellar has one sequence number per account, like Ethereum, and its workaround is multiple channel accounts.

---

## 9. Payment lanes

Ethereum has one gas limit per block, so payments compete with everything else. Tempo blocks carry **two** limits:

- **`gas_limit`**: the total for the block (as on Ethereum).
- **`general_gas_limit`**: the most that **non-payment** transactions may use (in the proposer's section of the block).

The difference is guaranteed headroom for payments.

### How a transaction is classified

The rule is defined by TIP-1045 and has been enforced since the T5 upgrade. A transaction counts as a **payment** if all of the following hold:

1. **Every top-level call** in the transaction matches an entry in the payment allow-list. An entry is a **target** (any address with the TIP-20 prefix `0x20c0…`, or the `TIP20ChannelReserve` precompile) plus a **function selector**:
   - TIP-20: `transfer`, `transferWithMemo`, `transferFrom`, `transferFromWithMemo`, `approve`, `mint`, `mintWithMemo`, `burn`, `burnWithMemo`
   - TIP20ChannelReserve: `open`, `topUp`, `settle`, `close`, `requestClose`, `withdraw` (payment channels)
2. The calldata is exactly well-formed for that function, with no extra trailing bytes.
3. There is no access list.
4. There is no EIP-7702 or Tempo authorization list.
5. Any key authorization is ≤ 1024 bytes.

Users don't opt in; classification is automatic. Signatures, fee sponsorship and validity windows don't affect the result.

### Why money moving into or out of an escrow is *not* a payment

The key point is that **classification looks at the transaction's bytes before it runs, and only at the top-level calls.** It never looks at what a contract does internally.

Walk through our InvoiceDiscount flows:

| Transaction | Top-level call target | Lane |
|---|---|---|
| Buyer approves the escrow to pull funds | `token.approve(escrow, amt)` (TIP-20) | **Payment** |
| Buyer pays the seller directly (no escrow) | `token.transferWithMemo(seller, amt, invoiceId)` (TIP-20) | **Payment** |
| Buyer deposits into escrow | `escrow.deposit(invoiceId)` (our contract, which *internally* calls `token.transferFrom`) | **General** |
| Buyer or seller triggers early payment | `escrow.payEarly(invoiceId)` (our contract, which internally calls `token.transfer(seller, …)` and refunds the buyer the discount) | **General** |
| Batched `[approve, escrow.deposit]` in one `0x76` tx | One call is not on the allow-list | **General** (every call must qualify) |

So to answer the question directly: it is **not** that the release call is general while the money movement inside it is separately counted as a payment. The lane is decided **once, for the whole transaction**, from its top-level call. If that call goes to our escrow, the entire transaction is general, including the TIP-20 transfers the escrow makes internally. The internal transfer is identical to a direct one; it just doesn't change the classification.

**Why it's designed this way:**

1. **It must be decidable without executing anything.** Validators enforce `general_gas_limit` as a consensus rule while building and checking blocks. If classification required running the transaction ("does this contract eventually move tokens?"), the builder would have to execute a transaction just to decide whether it's allowed in that section of the block, and the answer could depend on state that changes. Looking at the target prefix and the 4-byte selector is instant, needs no state, and every validator gets the same answer.
2. **Otherwise anyone could sneak into the lane.** If "any call that eventually moves a TIP-20" counted, a DEX swap, a liquidation or an NFT purchase could all claim the payment lane, because they all move tokens somewhere inside. The reserved lane would fill with exactly the traffic it's meant to protect payments from. Restricting it to the token precompiles' own transfer functions, whose behavior and cost the protocol knows exactly, keeps it honest.
3. **The data-carrying fields are excluded for the same reason.** Access lists and authorization lists can carry arbitrary attacker-chosen data, so a transaction that includes them is pushed to the general lane.

**What it means for us in practice:**

- **Nothing breaks.** General-lane transactions are included normally and are just as final. The lane matters only when the chain is congested by non-payment traffic. In that case our escrow calls compete for general blockspace (and may cost more), while plain transfers keep flowing.
- **A contract can't detect a plain transfer.** You might think a buyer could just `transfer` funds to the escrow address (a payment-lane transaction) to fund it. But TIP-20 has no receive hooks, so the escrow wouldn't know the funds arrived or which invoice they're for. Someone would still have to make a general-lane call to record it. The pull pattern (`approve` + `deposit`) is simpler and safer.
- **The approve leg *is* in the payment lane.** So in a congested chain the buyer's approval goes through on reserved space, and only the deposit call competes for general space.

---

## Sources

- [Consensus and finality (Simplex BFT)](https://tempo.xyz/developers/docs/protocol/blockspace/consensus)
- [Consensus, DKG and network identity](https://tempo.xyz/developers/docs/guide/node/consensus-and-dkg)
- [Commonware Simplex docs](https://docs.rs/commonware-consensus/0.0.65/commonware_consensus/simplex/)
- [TIP-1031: consensus context in header](https://tempo.xyz/developers/docs/protocol/tips/tip-1031)
- [TIP-20 overview](https://tempo.xyz/developers/docs/protocol/tip20/overview) · [TIP-20 spec](https://tempo.xyz/developers/docs/protocol/tip20/spec) · [TIP-403](https://tempo.xyz/developers/docs/protocol/tip403/spec) · [TIP-1006 burnAt](https://tempo.xyz/developers/docs/protocol/tips/tip-1006) · [TIP-1004 permit (pause behavior)](https://tempo.xyz/developers/docs/protocol/tips/tip-1004)
- [pathUSD and quote tokens](https://tempo.xyz/developers/docs/protocol/exchange/quote-tokens) · [Stablecoin DEX](https://tempo.xyz/developers/docs/protocol/exchange)
- [Fees](https://tempo.xyz/developers/docs/protocol/fees) · [Fee AMM](https://tempo.xyz/developers/docs/protocol/fees/fee-amm) · [TIP-1007](https://tempo.xyz/developers/docs/protocol/tips/tip-1007)
- [Tempo Transactions spec](https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction) · [TIP-1009 expiring nonces](https://tempo.xyz/developers/docs/protocol/tips/tip-1009) · [Send payments in parallel](https://tempo.xyz/developers/docs/guide/payments/send-parallel-transactions)
- [Payment lane spec](https://tempo.xyz/developers/docs/protocol/blockspace/payment-lane-specification) · [TIP-1045 payment classification](https://tips.sh/1045)
