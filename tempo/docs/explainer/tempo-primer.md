# Tempo Primer (for Ethereum, Solana and Stellar developers)

> Written October 2026 from the official Tempo docs (`tempo.xyz/developers`). Tempo ships named network upgrades often (T1, T2, … it is past T12 as of this writing), so check the [Changelog](https://tempo.xyz/developers/docs/protocol/upgrades) before relying on a detail.
>
> **The Tempo explainers:**
> - **This file:** what Tempo is, how it compares to other chains, and its tooling.
> - [`tempo-how-it-works.md`](./tempo-how-it-works.md): the technical mechanics. Simplex BFT consensus, VRF leader selection, finality, block speed, TIP-20 in depth, pathUSD, fees, 2D nonces, payment lanes.
> - [`tempo-zones.md`](./tempo-zones.md): Tempo Zones, the private stablecoin ledgers.

## TL;DR

**Tempo is an EVM chain built specifically for stablecoin payments.** If you know Ethereum, you already know 80% of Tempo: same addresses, same Solidity, same JSON-RPC, same Foundry/viem tooling. The other 20% is what makes it a payments chain:

1. **No native token.** There is no ETH equivalent. Gas is priced in USD and paid in any supported USD stablecoin.
2. **Stablecoins are built into the protocol (TIP-20), not ordinary contracts.** TIP-20 is ERC-20 plus memos, compliance policies and issuer roles, implemented inside the node itself.
3. **A new transaction type (`0x76`) gives you smart-account features natively**: passkey signing, batching, fee sponsorship, parallel nonces, expiry windows and scoped session keys. On Ethereum you would need ERC-4337 or EIP-7702 for these.
4. **Fast, final blocks.** About 0.5–0.6 s blocks with deterministic finality (Simplex BFT). No reorgs after finality, and no 12-minute wait like Ethereum.
5. **Reserved blockspace for payments** ("payment lanes"), so a busy DeFi app can't crowd out transfers.

Tempo was incubated by **Stripe and Paradigm**, and mainnet launched on **March 18, 2026**.

**A useful mental model:** Tempo is *Ethereum's developer experience* combined with *Stellar's payments primitives* (memos, issuer controls, a built-in DEX, fee sponsorship, fast deterministic finality), with stablecoins in place of a volatile gas token.

---

## 1. The four chains side by side

| | **Ethereum** | **Tempo** | **Stellar** | **Solana** |
|---|---|---|---|---|
| Purpose | General-purpose smart contracts | Stablecoin payments (general EVM contracts also work) | Payments and asset issuance | High-throughput general purpose |
| VM / contracts | EVM, Solidity/Vyper | **EVM (targets the Osaka fork)**, Solidity | Soroban (Rust → WASM) | SVM / Sealevel (Rust, Anchor) |
| Native token | ETH (gas + staking) | **None.** Fees are in USD stablecoins | XLM (fees + reserves) | SOL (fees + rent + staking) |
| Fee unit | gwei of ETH | USD, paid in any eligible TIP-20 stablecoin | stroops of XLM | lamports of SOL |
| Consensus | Gasper (PoS) | **Simplex BFT** (Commonware), permissioned validators | SCP (federated Byzantine agreement) | Tower BFT + Proof of History |
| Leader selection | RANDAO, schedule known ~1 epoch ahead | **Threshold-BLS VRF**, revealed one view ahead | Nomination protocol (no single leader) | Stake-weighted schedule known per epoch |
| Block time | ~12 s | **~0.5–0.6 s** | ~5–6 s ledgers | ~0.4 s slots |
| Finality | ~12–15 min (2 epochs) | **Deterministic, sub-second** | Deterministic, per ledger | ~12.8 s (optimistic confirmation in ~1 s) |
| Account model | EOAs + contract accounts, secp256k1 | EOAs (secp256k1, **P-256, WebAuthn/passkeys**) + contracts | Accounts with signers/thresholds, ed25519 | Accounts own data; programs are stateless |
| Replay protection | One sequential nonce | **2D nonces** (many parallel streams) + expiring nonces | One sequence number | Recent blockhash (expires) |
| Token standard | ERC-20 (each token is its own contract) | **TIP-20** (built-in precompile, 6 decimals) | Classic assets + SAC (also built in) | SPL Token / Token-2022 |
| Built-in memo | No | **Yes**, 32 bytes per transfer | Yes (tx memo) | Memo program |
| Issuer compliance controls | Per-contract (e.g. USDC's blacklist) | **Protocol-level** (TIP-403 policy registry, roles, pause) | Protocol-level (auth required/revocable/clawback) | Token-2022 extensions |
| Built-in DEX | No (Uniswap etc. are apps) | **Yes**, a stablecoin order book | Yes, the SDEX order book + AMMs | No (apps) |
| Batching / sponsorship | ERC-4337 / EIP-7702 / Multicall | **Native in the `0x76` transaction type** | Native (multi-op tx, fee-bump tx) | Native (multi-instruction tx, fee payer) |
| Privacy | Public | Public, plus optional **Zones** (private ledgers) | Public | Public |

---

## 2. Tempo vs Ethereum

### 2.1 What stays the same

- **Addresses and keys:** 20-byte `0x…` addresses. Your existing MetaMask account works as-is.
- **Solidity and the EVM:** every opcode is supported, and execution targets the **Osaka** hard fork.
- **JSON-RPC:** `eth_blockNumber`, `eth_call`, `eth_sendRawTransaction`, `eth_getLogs`… all work. Tempo adds a few of its own (e.g. `tempo_fundAddress` on testnet).
- **Standard transactions:** legacy/EIP-1559 transactions still work for basic transfers and calls.
- **Tooling:** Foundry, viem, wagmi, web3.py and Alloy all work (see [§4](#4-the-tools-explained)).

### 2.2 No native token: the biggest porting gotcha

| Ethereum behavior | Tempo behavior | What to do instead |
|---|---|---|
| `address(x).balance` / `BALANCE` / `SELFBALANCE` | **Always returns 0** | `IERC20(token).balanceOf(x)` on a TIP-20 |
| `msg.value` / `CALLVALUE` | **Always 0.** `payable` is pointless | Pull stablecoins with `transferFrom` (approve-then-pull) |
| `eth_getBalance` RPC | Returns a huge placeholder (~4.24e75) so wallets don't block users | Show TIP-20 balances in the UI, not a "native balance" |
| Wallet currency symbol "ETH" | Use **"USD"** | |

> **For InvoiceDiscount:** the escrow must hold a TIP-20 stablecoin. You can't lock "native" value the way you could lock ETH. This is the same pattern as the Stellar version, which holds a token via the token interface.

### 2.3 Fees in stablecoins

Gas still uses EIP-1559-style fields, but it is **denominated in USD** and paid in any USD TIP-20 with liquidity in the protocol's **Fee AMM**. The Fee AMM converts your token to the validator's preferred one at a fixed 0.3% spread. If you don't choose a fee token, it falls back to the token you're transferring, and otherwise to **pathUSD**. Apps can **sponsor** users' fees natively, with no ERC-4337 paymaster. → [Details](./tempo-how-it-works.md#7-fees-without-a-native-token)

### 2.4 TIP-20: stablecoins as part of the protocol

On Ethereum, USDC is just a contract Circle deployed. Every stablecoin's code differs, and the chain itself knows nothing about them. On Tempo, **the token logic lives inside the node software** (a "precompile"), so every TIP-20 behaves identically. Issuers only *configure* their token (roles, compliance policy, supply cap, pause) and can't change its code. Because the protocol trusts this code, TIP-20s can **pay gas**, get **payment-lane priority**, and trade on the **built-in DEX**. Your closest reference point is Stellar's classic assets plus the Stellar Asset Contract, which also live in the protocol rather than in user contracts.

TIP-20s are ERC-20-compatible (`IERC20` code just works) with **6 decimals**, plus `transferWithMemo`/`transferFromWithMemo` (32-byte memos), built-in roles, and TIP-403 allow/deny policies. → [Full TIP-20 deep dive](./tempo-how-it-works.md#5-protocol-level-stablecoins-tip-20-in-depth)

### 2.5 pathUSD

pathUSD is the first stablecoin on Tempo, predeployed at genesis at `0x20c0…0000` and issued on mainnet by Bridge. It's **routing infrastructure, not a consumer coin**. It's the neutral hub that other stablecoins pair against on the built-in DEX, and the fallback fee token. For holding and paying, Tempo recommends **OUSD**. On testnet the faucet hands out play-money pathUSD at the same address. → [pathUSD and the quote-token tree](./tempo-how-it-works.md#6-pathusd-and-the-quote-token-tree)

### 2.6 Tempo Transactions (type `0x76`): account abstraction built in

| Feature | Field(s) | Ethereum equivalent |
|---|---|---|
| **Batching** (atomic multi-call) | `calls: Vec<Call>` | Multicall3, ERC-4337 `executeBatch`, EIP-5792 |
| **Fee sponsorship** | `fee_payer_signature` | ERC-4337 paymaster |
| **Choose fee token** | `fee_token` | (none) |
| **Passkey / P-256 / WebAuthn signing** | signature types `0x01`/`0x02` | RIP-7212 + a smart wallet |
| **Parallel nonces** | `nonce_key` + `nonce` (2D nonces) | ERC-4337 nonce keys |
| **Expiring nonces** (no sequence at all) | `nonce_key = uint256.max` + `valid_before` | (none) |
| **Validity window** | `valid_after`, `valid_before` | (none natively) |
| **Access keys** (session keys with spending limits, expiry and call allow-lists) | `key_authorization` | ERC-7715, or smart-wallet session-key modules |
| **Delegation** | `aa_authorization_list` | EIP-7702 |

The practical result: a user can sign with a **passkey** (Face ID/Touch ID), pay **no gas themselves**, and do **approve + deposit in one atomic transaction**, all without deploying a smart wallet. Access keys can't sign a top-level contract creation. → [2D and expiring nonces explained](./tempo-how-it-works.md#8-2d-nonces-and-expiring-nonces)

### 2.7 Consensus and finality

Tempo uses **Simplex BFT**, a voting-based consensus run by a **permissioned committee** of validators. A block is final as soon as ⅔ of validators sign a finalization certificate, which takes under a second. After that it can **never** be reorganized; if too many validators fail, the chain **halts** rather than forks. Leaders are chosen by an unbiasable random beacon (a VRF), revealed only one round ahead, which blunts targeted DoS and MEV. Tempo is its **own L1**; it does not settle to Ethereum.

| | Ethereum | Tempo |
|---|---|---|
| Block time | 12 s | ~0.5–0.6 s |
| Finality | ~13 min | Sub-second, deterministic |
| Validators | Permissionless (32 ETH) | **Permissioned** (onboarding is coordinated with Tempo) |

→ [Simplex, VRF, finality and block speed explained](./tempo-how-it-works.md#1-consensus-simplex-bft)

### 2.8 Payment lanes

Each block has a second gas limit that caps **non-payment** transactions, leaving guaranteed room for plain TIP-20 transfers. Classification is automatic. A call into a custom contract (like our escrow) is *not* a payment-lane transaction. → [Details](./tempo-how-it-works.md#9-payment-lanes)

### 2.9 Gas costs differ: state creation is expensive

| Operation | Ethereum | Tempo |
|---|---|---|
| New storage slot (SSTORE 0 → non-zero) | 20,000 gas | **250,000 gas** |
| Account creation | 0 | **250,000 gas** |
| Contract creation, per byte | 200 gas | **1,000 gas** |
| Per-tx gas cap | 16,777,216 (EIP-7825) | 30,000,000 |

A transfer to a brand-new address costs ~300k gas, and **contract deployments cost 5–10× more gas than on Ethereum**. Gas is cheap in USD, but don't reuse Ethereum-calibrated gas limits. This also favors designs that write fewer fresh storage slots.

### 2.10 Built-in protocol contracts

| Contract | Address | Ethereum analogue |
|---|---|---|
| TIP-20 Factory | `0x20fc000000000000000000000000000000000000` | Deploying your own ERC-20 |
| Fee Manager (fee tokens, Fee AMM) | `0xfeec000000000000000000000000000000000000` | (none) |
| Stablecoin DEX (order book) | `0xdec0000000000000000000000000000000000000` | Uniswap/Curve (as apps) |
| Nonce precompile (2D nonces) | `0x4E4F4E4345000000000000000000000000000000` | (none) |
| pathUSD | `0x20c0000000000000000000000000000000000000` | (none) |

### 2.11 Privacy: Tempo Zones

On mainnet every balance is public. **Zones** are operator-run private stablecoin ledgers anchored to Tempo (limited preview). → [Full Zones explainer](./tempo-zones.md)

### 2.12 Machine Payments Protocol (MPP)

Launched with mainnet, MPP is an open standard for programs and AI agents to pay for HTTP APIs per request (similar in spirit to Coinbase's x402 / HTTP 402). It's not relevant to InvoiceDiscount, but it features heavily in the docs.

---

## 3. Quick contrasts with Solana and Stellar

**vs Stellar (what you built the first version on):**
- *Similar:* payments-first chain, memos, protocol-level assets with issuer controls, built-in DEX, fee sponsorship (Stellar fee-bump ≈ Tempo `fee_payer`), multi-operation atomic transactions (≈ Tempo `calls`), fast deterministic finality, curated validators.
- *Different:* Soroban is Rust→WASM; Tempo is **Solidity on the EVM**. Stellar needs XLM for fees and reserves; Tempo needs **no native token**. Stellar requires trustlines before holding an asset; Tempo has **no trustlines** (any address can receive a TIP-20 unless it sets a receive policy). Stellar path payments search for any route, while Tempo's DEX has exactly one route per pair. Stellar uses `G…`/`C…` strkeys; Tempo uses `0x…` addresses.

**vs Solana:**
- *Similar:* sub-second blocks, native fee payer, multi-instruction atomic transactions, expiring replay protection (Solana's recent blockhash ≈ Tempo's expiring nonces).
- *Different:* Solana separates stateless programs from data accounts that you pass in explicitly, uses Rust/Anchor, ed25519 keys, SOL rent and SPL tokens. Tempo uses the familiar EVM model, where contracts own their storage and you write Solidity.

---

## 4. The tools explained

You'll see these names everywhere. Here's what each one is, with the closest equivalent from the Stellar version of this project.

### Foundry: the contract developer toolkit

Foundry is the most popular Ethereum toolkit for writing, testing and deploying Solidity. It's written in Rust by Paradigm, Tempo's co-founder, and it supports Tempo natively. It ships four command-line programs:

| Tool | What it does | Stellar equivalent |
|---|---|---|
| **`forge`** | **Build, test and deploy** contracts. Tests are written *in Solidity*, and it supports fuzzing, gas reports, forking live chains, and deployment scripts. | `stellar contract build` + `cargo test` with `soroban-sdk` testutils + `stellar contract deploy` |
| **`cast`** | A **Swiss-army CLI for talking to a chain**: call view functions, send transactions, read balances and blocks, encode/decode ABI data, manage keys. | `stellar contract invoke`, `stellar keys`, Horizon/RPC queries |
| **`anvil`** | A **local blockchain node** on your machine for development, with pre-funded accounts, instant blocks, and the ability to fork mainnet/testnet state. Run it with Tempo mode for Tempo features. | `stellar container start local` (Quickstart) |
| **`chisel`** | A **Solidity REPL**: type Solidity lines and see results immediately. Handy for experimenting. | (none) |

Examples:

```bash
forge build                                    # compile
forge test -vvv                                # run Solidity tests with traces
forge create src/Escrow.sol:Escrow --rpc-url moderato --broadcast   # deploy
cast call $TOKEN "balanceOf(address)(uint256)" $ME --rpc-url moderato
cast send $TOKEN "transfer(address,uint256)" $TO 1000000 --rpc-url moderato --private-key $PK
anvil                                          # start a local chain at http://localhost:8545
chisel                                         # interactive Solidity prompt
```

On Tempo specifically: `forge init -n tempo` gives a Tempo starter project, `tempo-std` provides Solidity interfaces for TIP-20, FeeManager and the DEX, `--tempo.fee-token` picks the fee token, and `cast batch-send` sends a batched `0x76` transaction.

### viem: the TypeScript chain library

**viem** is a TypeScript library for talking to EVM chains from a frontend or backend. It reads state, builds and signs transactions, sends them and waits for receipts, decodes events, and does ABI encoding, all with strong typing. It's the modern successor to ethers.js and web3.js. Tempo support lives in `viem/tempo`, which adds actions like `client.token.transferSync(...)` and `client.fee.setUserToken(...)` and knows how to build `0x76` transactions.

*Stellar equivalent:* **`@stellar/stellar-sdk`**, which our Stellar frontend uses.

### wagmi: React hooks for wallets

**wagmi** is a React library built *on top of* viem. It handles **wallet connection** (MetaMask, WalletConnect, passkey wallets, Tempo Wallet), tracks the connected account and chain, and gives you hooks like `useAccount()`, `useReadContract()` and `useSendTransaction()` with loading and error states built in. Tempo adds `wagmi/tempo` hooks (e.g. `Hooks.token.useTransferSync()`) and a `tempoWallet()` connector.

*Stellar equivalent:* **`@stellar/freighter-api`** (wallet connection) plus the React glue code we wrote by hand.

### Alloy: the Rust chain library

**Alloy** is the Rust equivalent of viem: core types (addresses, U256, transactions), RPC providers, signers and ABI tooling. It's the foundation that Foundry and Reth are built on. Tempo provides **`tempo-alloy`** for Tempo transaction types. You'd only use it for a Rust backend or tooling; our project is unlikely to need it.

*Stellar equivalent:* nothing in our Stellar project; we only used Rust on-chain (`soroban-sdk`), not for off-chain clients.

### Other tools

| Job | Ethereum tool | Tempo equivalent |
|---|---|---|
| Python client | web3.py | web3.py + **`pytempo`** |
| Go client | go-ethereum | **`tempo-go`** |
| Node software | Geth / Reth | **`tempo node`** (built on Reth + Commonware) |
| All-in-one CLI | (none) | **`tempo` CLI**: `tempo wallet`, `tempo request`, `tempo api`, `tempo node`, `tempo download` |
| Test-suite node pool | Anvil / Hardhat Network | **`prool`** (`Instance.tempo()`) |
| Block explorer | Etherscan | **Tempo Explorer**: `explore.tempo.xyz` / `explore.testnet.tempo.xyz` |
| Contract verification | Etherscan / Sourcify | **Sourcify-compatible verifier** at `https://contracts.tempo.xyz` |
| Hosted RPC | Alchemy, Infura, QuickNode | **Alchemy** and other partners, plus public `rpc.tempo.xyz` |
| Indexed data API | Etherscan API, The Graph | **Tempo API** (indexer), Dune |
| Testnet faucet | Sepolia faucets | **`tempo_fundAddress`** RPC or the web faucet |
| Gasless UX | ERC-4337 bundler + paymaster | **Native fee sponsorship**, Tempo Fee Payer API |
| Smart wallet / passkeys | Coinbase Smart Wallet, Safe | **Tempo Wallet**, or any account signing WebAuthn natively |
| Bridging | LayerZero, CCTP, native bridges | **LayerZero** (Stargate for USDC.e/EURC.e, OFT for USDT0), Tempo **Routes** (beta) |
| Hardhat | Hardhat | Works as a generic EVM tool (the docs mention it for verification), but Foundry is the first-class path |

---

## 5. Networks

| | Mainnet | Testnet (**Moderato**) |
|---|---|---|
| Chain ID | `4217` | `42431` |
| HTTP RPC | `https://rpc.tempo.xyz` | `https://rpc.moderato.tempo.xyz` |
| WebSocket | `wss://rpc.tempo.xyz` | `wss://rpc.moderato.tempo.xyz` |
| Explorer | https://explore.tempo.xyz | https://explore.testnet.tempo.xyz |
| Currency symbol | `USD` | `USD` |

**Testnet faucet tokens** (all TIP-20, 6 decimals):

| Token | Address |
|---|---|
| pathUSD | `0x20c0000000000000000000000000000000000000` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` |
| BetaUSD | `0x20c0000000000000000000000000000000000002` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` |
| OUSD | `0x20c0000000000000000000006a37da5c996874be` |

**Mainnet stablecoins** listed in the docs include **OUSD** (Open USD, recommended), **pathUSD**, **USDC.e** and **EURC.e** (bridged via Stargate/LayerZero), **USDT0**, and AllUnity's EURAU/SEKAU/CHFAU. **PYUSD is not listed.**

---

## 6. Hands-on examples

### Foundry: new project, fund, test and deploy on Moderato

```bash
foundryup                                   # upstream Foundry has Tempo support
forge init -n tempo my-project && cd my-project

export TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz
export VERIFIER_URL=https://contracts.tempo.xyz

cast wallet new                                             # make a key
cast rpc tempo_fundAddress <ADDR> --rpc-url $TEMPO_RPC_URL  # testnet faucet

forge test --fork-url "$TEMPO_RPC_URL"                      # fork-test against testnet
forge create src/Mail.sol:Mail \
  --rpc-url $TEMPO_RPC_URL --interactive --broadcast --verify \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001 \
  --constructor-args 0x20c0000000000000000000000000000000000001
```

### viem: pay an invoice with a memo

```ts
import { createClient } from 'viem/tempo'
import { toHex } from 'viem'

const client = createClient({ testnet: true /* + account */ })

const { receipt } = await client.token.transferSync({
  token: '0x20c0000000000000000000000000000000000001', // AlphaUSD
  to: seller,
  amount: 10_000_000n,                                 // 10.00 (6 decimals)
  memo: toHex('INV-2026-0042', { size: 32 }),          // 32 bytes, not chars
})
```

### Solidity: what changes in an escrow contract

```solidity
// Ethereum habit (doesn't work on Tempo: msg.value is always 0)
function deposit() external payable { require(msg.value == amount); }

// Tempo: pull a TIP-20 via the standard ERC-20 interface
function deposit() external {
    IERC20(token).transferFrom(msg.sender, address(this), amount);
}
```

With a Tempo Transaction the buyer can send `approve` + `deposit` as **one atomic batch**, optionally with fees sponsored by our app.

---

## 7. What this means for InvoiceDiscount on Tempo (first impressions)

| Concern | Stellar version | Tempo version |
|---|---|---|
| Language | Rust / Soroban SDK | Solidity / Foundry |
| Frontend libraries | `@stellar/stellar-sdk` + `@stellar/freighter-api` | viem + wagmi |
| Holding funds | Contract holds token via SAC | Contract holds a TIP-20 via `IERC20` |
| Time-based discount tiers | `env.ledger().timestamp()` | `block.timestamp` |
| Invoice reference | Contract field | Contract storage and/or `transferFromWithMemo` (32-byte invoice ID) |
| Who pays fees | Payer needs XLM (or fee-bump) | Payer pays in stablecoin, or the app sponsors via `fee_payer` |
| Settlement certainty | ~5 s ledger close | Sub-second finality |
| One contract per invoice? | Deployed per invoice | Possible, but **deployments are 5–10× Ethereum gas**. A single registry contract holding many invoices is likely cheaper (to decide in planning) |
| Token risks to handle | Trustline/authorization | Issuer pause, TIP-403 blocks, receive policies diverting payouts |

---

## 8. Glossary

- **TIP**: Tempo Improvement Proposal (≈ EIP). Specs live at `tips.sh`.
- **TIP-20**: Tempo's built-in, ERC-20-compatible stablecoin standard.
- **TIP-403**: Policy Registry for whitelist/blacklist transfer rules.
- **Precompile**: a contract address whose logic is native code inside the node rather than EVM bytecode.
- **Tempo Transaction**: type `0x76` transaction with batching, sponsorship, passkeys, 2D nonces and access keys.
- **2D nonce**: a per-account set of independent nonce streams, selected by `nonce_key`.
- **Expiring nonce**: replay protection by short validity window instead of a counter.
- **Access key**: a scoped, optionally expiring sub-key with spending limits and call allow-lists.
- **Fee AMM**: protocol pool that converts fee payments into the validator's preferred stablecoin.
- **Stablecoin DEX**: built-in order book for same-currency stablecoin swaps.
- **pathUSD**: the neutral hub/quote stablecoin and fallback fee token.
- **Quote token**: the token a TIP-20 is paired against on the DEX. These pairings form a tree rooted at pathUSD.
- **Payment lane**: blockspace reserved for payment-classified transactions.
- **Simplex BFT**: Tempo's voting-based consensus protocol (from Commonware).
- **VRF**: verifiable random function, used to pick each round's leader unpredictably.
- **Network identity**: the single threshold-BLS public key that verifies Tempo finality certificates.
- **Moderato**: the Tempo testnet.
- **Zones**: private stablecoin ledgers anchored to Tempo (limited preview).
- **MPP**: Machine Payments Protocol, pay-per-request HTTP payments.
- **T1…T13**: named Tempo network upgrades (≈ Ethereum hard forks).

## Sources

- [EVM differences](https://tempo.xyz/developers/docs/quickstart/evm-compatibility)
- [Network details](https://tempo.xyz/developers/docs/quickstart/connection-details) · [Faucet](https://tempo.xyz/developers/docs/quickstart/faucet)
- [Tempo Transactions spec](https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction)
- [Fees](https://tempo.xyz/developers/docs/protocol/fees) · [TIP-20 overview](https://tempo.xyz/developers/docs/protocol/tip20/overview)
- [Consensus (Simplex BFT)](https://tempo.xyz/developers/docs/protocol/blockspace/consensus)
- [Predeployed contracts](https://tempo.xyz/developers/docs/quickstart/predeployed-contracts)
- [Foundry](https://tempo.xyz/developers/docs/sdk/foundry) · [SDKs](https://tempo.xyz/developers/docs/sdk) · [CLI](https://tempo.xyz/developers/docs/cli)
- [Send payments](https://tempo.xyz/developers/docs/guide/payments/send-a-payment)
- [Stablecoin partners](https://tempo.xyz/developers/docs/partners/stablecoins) · [LayerZero bridging](https://tempo.xyz/developers/docs/guide/bridge-layerzero)
- [Mainnet launch coverage (CoinDesk, 2026-03-18)](https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents)
