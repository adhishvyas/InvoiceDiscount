# Tempo Zones: Private Stablecoin Ledgers

> Part of the Tempo explainers. See [`tempo-primer.md`](./tempo-primer.md) and [`tempo-how-it-works.md`](./tempo-how-it-works.md).
>
> **Status (October 2026): limited preview.** You need to [contact Tempo](https://tempo.xyz/contact) for access. The docs describe source code reviewed on September 23, 2026, and several security pieces are still being rolled out (see [§7](#7-trust-model-and-current-limitations)). Not needed for the InvoiceDiscount PoC.

---

## 1. The problem Zones solve

On Tempo mainnet, as on Ethereum, **everything is public**. Anyone can call `balanceOf(anyAddress)`, and every transfer appears in the explorer with sender, recipient, amount and memo.

That's a non-starter for many real payment flows:
- a company doesn't want competitors reading its payroll or supplier payments
- a merchant doesn't want its revenue visible to anyone with an explorer
- in our invoice-discounting case, a buyer may not want the world to see which suppliers it pays early, and at what discount

**Tempo Zones** are **private stablecoin ledgers attached to Tempo**. Balances and account activity inside a Zone are hidden from the public and from other users, but funds can still move in and out of Tempo's public liquidity.

## 2. The mental model

A Zone is roughly a **private, operator-run sidechain/L2 that is purpose-built for stablecoins** and anchored to Tempo:

```
             PUBLIC (Tempo mainnet)                      PRIVATE (the Zone)
  ┌──────────────────────────────────────┐        ┌──────────────────────────────┐
  │                                      │ deposit│                              │
  │  User ──depositEncrypted()──► ZonePortal ─────►  ZoneInbox ──mint──► Alice    │
  │                              (holds the       │                              │
  │                               backing         │   Alice ──transfer──► Bob    │
  │                               tokens)         │   (private ledger, run by    │
  │                                  ▲            │    the Zone operator)        │
  │  Recipient ◄──release────────────┤  withdraw  │                              │
  │                                  └────────────┤  ZoneOutbox ◄──burn── Bob    │
  │                                      │        │                              │
  │  ZonePortal ◄── batch commitments + sequencer signatures (settlement)        │
  └──────────────────────────────────────┘        └──────────────────────────────┘
```

- The **ZonePortal** on Tempo is a vault. It **holds the real TIP-20 tokens** that back every balance inside the Zone.
- The **Zone** is a separate EVM network with its own chain ID, run by an **operator**. It keeps the private account ledger.
- Tokens inside the Zone are 1:1 claims on tokens locked in the portal.

How it compares to things you know:

| | Ethereum rollup (e.g. Optimism, Base) | Tempo Zone |
|---|---|---|
| Anchored to | Ethereum (L1) | Tempo |
| Run by | A sequencer | An operator / sequencer set (up to 8 signers) |
| State published? | Yes. Transaction data is posted to L1 so anyone can rebuild state | **No.** The private ledger is never published |
| Who can read balances | Everyone | Only the account owner (and the operator) |
| General smart contracts | Yes | **No.** Contract creation is disabled; it's a fixed set of system contracts |
| Correctness proof | Fraud proofs (optimistic) or ZK proofs | Sequencer signatures, plus a verifier that will check **TEE (AWS Nitro) attestations** (still rolling out) |

The closest analogue is a **validium** or a **private permissioned ledger** with a public bridge, such as a bank's internal ledger connected to a public settlement network.

### Who runs a Zone: operator, sequencers, admin, verifier

**A Zone has no validators.** There is no consensus protocol and no validator set inside a Zone. The Zone runtime doesn't even load Tempo's validator-config precompiles. Tempo's own validators don't re-execute Zone transactions either. They only run the `ZonePortal` contract, which checks what the operator submits. A Zone is closer to a single company's database server than to a blockchain network.

The roles:

| Role | Who / what | What it does |
|---|---|---|
| **Operator** | The organization running the Zone (e.g. a payments company or bank) | Runs the infrastructure: a **Tempo node** plus the **Zone nodes**, the authenticated RPC, the enclave prover (when configured), and the keys for the roles below. "Operator" is the umbrella term; on-chain, its powers show up as the leader, sequencer and admin roles. |
| **Leader** (block producer) | One sequencer address, set with `ZonePortal.setLeader(newLeader, expectedEpoch)` | The single node that **produces Zone blocks**: it orders transactions, executes them, and updates the private state. Leader epochs fence off the previous leader, so only one is active at a time. |
| **Sequencer set** | **Up to 8** addresses plus a signature threshold (an M-of-N quorum), set with `ZonePortal.setSequencerSet(newSequencers, newThreshold)` | **Signs settlement certificates**, i.e. the batch commitments submitted to the portal. A batch needs at least `threshold` distinct signatures from the active set. Changing the set invalidates certificates signed under the old configuration. Sequencers also call `submitBatch` and `processWithdrawals` on Tempo, set the Zone's RPC URL, and can register the deposit encryption key. |
| **Portal admin** | An address set when the Zone is created (can be a Safe multisig) | Configures the portal: the sequencer set and leader, which TIP-20 tokens are enabled (an irreversible step), the deposit fee rate (`zoneGasRate`) and the cap on the withdrawal fee rate, account access lists (closed-loop mode) and callback gateways. The admin also collects deposit fees, can pause the portal, and can permanently give up individual powers ("abdication"). |
| **Verifier** | **Not a party but a contract**: the shared Zone verifier on Tempo at `0x5a56…0000`, managed by the protocol | Called by the portal on every batch to check that the batch was **executed correctly**. Its job is to check an **AWS Nitro Enclave attestation** that the batch was replayed inside a trusted enclave. That check is **not fully enforced yet** (see [§7](#7-trust-model-and-current-limitations)). |
| **Prover** (off-chain) | A service the operator runs inside an **AWS Nitro Enclave** | Replays each batch with the **stateless proof function** (SPF) and produces the Nitro attestation that the verifier checks. ZK proofs are **not implemented**. |
| **RPC-only followers** (optional) | Extra Zone nodes that don't produce blocks | Can re-validate batches as observers (`--sequencer.enable-prover` on an `rpc_only` node). Their results **don't affect settlement**. |
| **ZoneFactory owner** | The `ZoneFactory.owner()` address (the protocol side, not the operator) | The only party that can **create Zones** today. |

**Operator responsibilities, in short:**
- **Liveness:** produce blocks, import finalized Tempo checkpoints (`ZoneInbox.advanceTempo`), process deposits in order, and submit batches and withdrawals to Tempo. If it stops, the Zone halts and withdrawals stall, since there are no forced exits.
- **Deposit decryption:** publish an encryption key and decrypt each deposit's recipient, with a Chaum–Pedersen proof that the decryption was done correctly (see [§3](#3-the-lifecycle-of-funds)).
- **Data custody:** the operator is the **only** holder of the private ledger. No one else can rebuild it.
- **Access control:** issue and check RPC authorization, and manage the access lists and gateways.
- **Fees:** set fee rates within the admin's bounds. Deposit fees go to the admin; Zone gas fees are collected through `ZoneFeeManager`.

So the answer to "are they running their own validators?" is no. They run a **sequencer (leader) node plus up to 8 signing keys**, not a validator set. The 8 keys are an M-of-N signing quorum for settlement, not a consensus protocol. Nothing requires those keys to belong to different organizations.

### Can you deploy contracts in a Zone?

**No, not today. Zones are for TIP-20 payments only.**

- Contract creation is limited to **protocol-allowlisted deployers**, and that allowlist is **currently empty**. Users can't send deployment transactions, and `CREATE` / `CREATE2` are disabled.
- Each Zone runs only a **fixed set of system contracts/precompiles**: the Zone TIP-20 tokens, `TempoState`, `ZoneInbox`, `ZoneOutbox` and `ZoneFeeManager`. You also can't create new tokens inside a Zone. Zone tokens mirror enabled Tempo TIP-20s at the same addresses.
- Even plain TIP-20 `transfer` calls **currently revert** during the permissioned phase (see [§7](#7-trust-model-and-current-limitations)).
- **Workaround:** custom logic must live on **public Tempo**, reached through **composable withdrawals** (`ZoneMessenger` callbacks into a Tempo contract that implements `IWithdrawalReceiver`). That contract can do a DEX swap or deposit into another Zone. Its inputs and outputs are public, though.

The reason is privacy. Arbitrary contracts could read balances and leak them, e.g. through events or gas usage (see [§4, Layer 3](#layer-3-privacy-enforced-inside-the-contracts-too)).

## 3. The lifecycle of funds

### Deposit (Tempo → Zone)

1. The user calls `ZonePortal.depositEncrypted(token, amount, keyIndex, encryptedPayload, tempoRefundRecipient)` on Tempo. There is **no plaintext deposit**: the recipient is always encrypted.
2. The portal validates the token, access rules and fee, **locks the tokens**, and appends the deposit to a queue.
3. Once the Tempo block is **finalized**, the Zone's `ZoneInbox` processes the queue in order, decrypts the recipient, and **mints** the Zone-side tokens to that recipient.
4. If decryption fails or the recipient can't receive (e.g. blocked by the issuer's policy), the funds are refunded to `tempoRefundRecipient` on Tempo.

#### What are `keyIndex` and `encryptedPayload`?

The recipient's Zone address and memo are hidden by **encrypting them to the sequencer's public key**. These two arguments carry that encryption.

**`keyIndex` (uint256): which operator encryption key you used.**
- The portal keeps a **history** of sequencer encryption keys, not just one key. Each call to `setSequencerEncryptionKey(x, yParity, popV, popR, popS)` appends an entry `{x, yParity, activationBlock}`. Only a sequencer or the admin can call it, and the call must include a **proof-of-possession** signature, so a key the sequencer can't actually decrypt with can't be registered.
- `keyIndex` is your entry's position in that history. Because it's stored with the deposit, the Zone (and the prover) know **which private key to decrypt with**, even after the key has been rotated.
- **Rotation grace period:** the latest key is always valid. An older key is still accepted for **86,400 blocks (about 1 day)** after it's replaced. After that, deposits using it revert with `EncryptionKeyExpired`, and an index that doesn't exist reverts with `InvalidEncryptionKeyIndex`.
- How a client gets it: read `sequencerEncryptionKey()` for the current key, and use `encryptionKeyCount() - 1` as the index (or call `encryptionKeyAt(i)` / `encryptionKeyAtBlock(n)`). Check `isEncryptionKeyValid(keyIndex)` before submitting.
- `keyIndex` is **public**. It reveals only which key was used, not who the deposit is for.

**`encryptedPayload` (a `DepositPayload` struct): the encrypted recipient + memo.**

```solidity
struct DepositPayload {
    bytes32 ephemeralPubkeyX;       // your one-time public key (X coordinate)
    uint8   ephemeralPubkeyYParity; // 0x02 or 0x03 (compressed point)
    bytes   ciphertext;             // AES-256-GCM of the 64-byte plaintext
    bytes12 nonce;                  // GCM nonce
    bytes16 tag;                    // GCM authentication tag
}
```

- **Plaintext (exactly 64 bytes):** `[to: 20 bytes][memo: 32 bytes][zero padding: 12 bytes]`. The portal rejects any ciphertext that isn't 64 bytes. Because every payload has the same length, its size gives nothing away.
- **How it's built (ECIES over secp256k1):** generate a one-time key pair → ECDH with the sequencer key at `keyIndex` to get a shared secret → derive an AES-256-GCM key → encrypt the 64-byte plaintext. You submit your one-time public key so the sequencer can compute the same shared secret.
- **How it's opened:** the sequencer computes the shared secret and supplies it to `ZoneInbox` together with a **Chaum–Pedersen proof** that it was computed correctly with the private key for `keyIndex`. The inbox then decrypts on-chain. If the GCM tag doesn't verify or the recipient can't receive the funds, the deposit is refunded to `tempoRefundRecipient`.
- **Who can read it:** only holders of the sequencer's private key, i.e. the operator. On Tempo, observers see the struct but not `to` or `memo`.

### Transact inside the Zone

Users send transactions to the Zone's **authenticated RPC**. The Zone updates its private state. Nothing about these transactions appears on Tempo.

### Withdraw (Zone → Tempo)

1. The user calls `ZoneOutbox`, which **burns** their Zone tokens and queues a withdrawal to a public Tempo address.
2. The operator groups Zone blocks into a **batch** and submits a commitment to the portal, signed by the sequencer quorum.
3. Once the portal accepts the batch, it **releases** the backing tokens to the recipient in FIFO order.

**Composable withdrawals:** a withdrawal can also call a Tempo contract atomically through `ZoneMessenger`, for example "withdraw 1,000 USDC.e, swap to OUSD on the DEX, deposit into another Zone" in one step. If the callback fails, the withdrawal bounces back into the Zone.

## 4. How privacy is maintained

Privacy comes from **five layers** working together. No single trick does it all.

### Layer 1: the ledger is never published

Unlike a rollup, the Zone doesn't post its transactions or state anywhere public. Only **batch commitments** (hashes of state transitions) reach Tempo. You can't rebuild balances from what's on Tempo.

### Layer 2: authenticated, account-scoped RPC

Every RPC request must carry an **authorization token** in the `X-Authorization-Token` header:
- it is signed by your Tempo account key (secp256k1, P-256/passkey or WebAuthn, or an access key)
- it includes a `"TempoZoneRPC"` prefix, the zone ID and chain ID (so it can't be replayed elsewhere), and issued/expiry times (at most 30 days)

The RPC then **scopes or redacts** every method:

| Method | What you get |
|---|---|
| `eth_getBalance`, `eth_getTransactionCount` | Your own values. Other accounts return `0x0` |
| `eth_call` | Always executed **as you** (`from` is forced to your address) |
| `eth_getTransactionByHash` / `…Receipt` | Only if **you** sent it; otherwise `null` |
| `eth_getLogs` | Only TIP-20 events where you are a party |
| `eth_getBlockByNumber` | Headers **without** transaction lists |
| `eth_feeHistory` | Redacted (fixed base fee, zero usage ratios, so activity levels don't leak) |
| `eth_getStorageAt` (raw storage) | **Blocked** |

### Layer 3: privacy enforced inside the contracts too

The RPC filter alone isn't enough, because a contract could read someone's balance and emit it in an event. So the Zone's TIP-20 precompiles enforce it **at execution time**:
- `balanceOf(account)` **reverts with `Unauthorized()`** unless `msg.sender == account`.
- `allowance(owner, spender)` works only for the owner or the spender, because a non-zero allowance reveals a relationship between two parties.
- Permit nonces, 2D nonces and access-key data are owner-only too.
- `totalSupply()`, `name()`, `symbol()` and `decimals()` stay public.

Combined with **disabled contract creation** (no `CREATE`/`CREATE2`, only fixed system contracts), no one can deploy a spy contract.

### Layer 4: closing side channels with fixed gas

On a normal EVM chain, a transfer to an address that has **never held the token** costs more gas (a fresh storage slot) than one to an existing holder. Watching gas usage would leak "has this person been paid before?". Zones charge a **flat 100,000 gas** for `transfer`, `transferFrom`, `transferWithMemo`, `transferFromWithMemo`, `approve` and `permit`, whatever the storage state.

### Layer 5: encrypted deposits

When you deposit from public Tempo, the **recipient and memo are encrypted** to the operator's published key. The scheme is ECIES over secp256k1: an ephemeral key, an ECDH shared secret, and AES-256-GCM. The Zone also verifies a Chaum–Pedersen proof that the decryption was done correctly. Observers on Tempo see *that* a deposit happened, but not *who* it's for or *why*.

## 5. What is and isn't private

| Data | Who can see it |
|---|---|
| Your balance and transaction history inside the Zone | **You**, and the **operator** |
| Other users' balances and activity | Not you. Only them and the operator |
| Deposit **recipient and memo** | Encrypted. Only the operator can decrypt |
| Deposit **token, amount, depositor, refund address** | **Public** on Tempo |
| Withdrawal **token, amount, destination** | **Public** on Tempo |
| Batch/settlement commitments | **Public** on Tempo |
| Timing of deposits and withdrawals | **Public** |

Two important caveats the docs stress:

1. **The operator sees everything.** Zones give privacy *from the public and other users*, not from the operator. It's like a bank: your neighbors can't see your account, but the bank can. (Compare zero-knowledge systems like Zcash or Aztec, where no one, operators included, can see.)
2. **The boundary leaks metadata.** If you deposit exactly 12,345.67 at 10:02 and someone withdraws exactly 12,345.67 at 10:05, an observer can guess the link. Amounts and timing at the edges are public.

## 6. Compliance still applies

Privacy doesn't bypass issuers. Each Zone imports **finalized Tempo checkpoints** into a `TempoState` precompile and applies each token's **TIP-403 transfer policies** as of that checkpoint. A frozen or sanctioned address on Tempo is also frozen inside the Zone, and token pauses apply too. This is what makes Zones viable for regulated stablecoin issuers, and it's a key difference from permissionless privacy pools.

## 7. Trust model and current limitations

| You trust… | Because… |
|---|---|
| **The operator for liveness** | If it stops producing blocks or settling batches, the Zone halts |
| **The sequencer for inclusion and ordering** | It can censor or reorder transactions, including withdrawals |
| **The sequencer for privacy** | It sees every transaction |
| **The sequencer for data availability** | The ledger isn't published, so no one else can reconstruct it |
| **The verifier for correctness** | Signatures alone don't prove the operator executed correctly |

As of the docs' September 23, 2026 review, the parts that would reduce this trust are **not fully live**:
- The reference Solidity verifier **returns `true` without checking execution**.
- A native **AWS Nitro enclave attestation** verifier arrived with the **T13** upgrade, but its approved enclave measurements were **unset**. During rollout a `NoProof` mode is accepted, which checks the signature quorum and continuity but **not execution**.
- **Forced exits** (withdrawing without the operator's cooperation, as rollups allow) are **not available**. Getting funds out depends on the operator continuing to process batches.
- **Public TIP-20 `transfer` calls currently revert** inside Zones. Token movement goes through the inbox/outbox system paths during the current permissioned phase.
- **Zone creation** is restricted to the ZoneFactory owner.

Emergency controls: the admin, a sequencer or a pause guardian can pause a portal for up to 30 days. Admins can also schedule the permanent giving-up of their own powers ("abdication") after a 30-day delay.

**Bottom line:** today a Zone is best seen as a **trusted operator providing confidentiality**, with Tempo holding the backing funds. The roadmap is toward hardware-attested execution, so you don't have to trust the operator's honesty, only its liveness.

## 8. Reference: contracts and addresses

**On Tempo (shared by all Zones):**

| Contract | Address | Role |
|---|---|---|
| `ZoneFactory` | `0x5AF2000000000000000000000000000000000000` | Creates Zones and deploys each one's portal |
| `ZonePortal` implementation | `0x5AD1000000000000000000000000000000000000` | Vault + bridge + settlement (one proxy per Zone) |
| Zone verifier | `0x5a56000000000000000000000000000000000000` | Checks batch proofs |
| `ZoneMessenger` | `0x5A4d000000000000000000000000000000000000` | Executes withdrawal callbacks |

**Inside each Zone:**

| Contract | Address | Role |
|---|---|---|
| `TempoState` | `0x1c00…0000` | Imported finalized Tempo headers (for deposits and policies) |
| `ZoneInbox` | `0x1c00…0001` | Processes deposits, mints tokens |
| `ZoneOutbox` | `0x1c00…0002` | Burns tokens, queues withdrawals |
| `ZoneFeeManager` | `0xfeec…0001` | Gas payment in any enabled TIP-20 (no Fee AMM; doesn't even need to be USD) |

**Chain IDs:** mainnet Zones use `421700000 + zone_id`, and Moderato Zones use `1424310000 + zone_id`. Read `eth_chainId` from the Zone RPC rather than computing it.

**Fees:** deposits pay `100,000 gas × zoneGasRate`, deducted from the deposit. Withdrawals pay `(50,000 + callbackGasLimit) × tempoGasRate`, on top of the amount.

## 9. Relevance to InvoiceDiscount

**Not for the PoC.** Zones are in limited preview, don't allow custom contracts (so our escrow contract couldn't run inside one), and add operator trust.

Conceptually, a future version could keep the escrow on public Tempo but have buyers and sellers hold their working balances in a Zone, so their payment relationships aren't publicly visible. That would need contract support inside Zones or a composable-withdrawal design. Worth revisiting if Zones mature.

## Sources

- [Zones overview (integration)](https://tempo.xyz/developers/docs/zones) · [Privacy](https://tempo.xyz/developers/docs/zones/privacy)
- [Zones protocol](https://tempo.xyz/developers/docs/protocol/zones) · [Architecture](https://tempo.xyz/developers/docs/protocol/zones/architecture) · [Accounts](https://tempo.xyz/developers/docs/protocol/zones/accounts)
- [Bridging](https://tempo.xyz/developers/docs/protocol/zones/bridging) · [RPC](https://tempo.xyz/developers/docs/protocol/zones/rpc) · [Execution & gas](https://tempo.xyz/developers/docs/protocol/zones/execution) · [Proving](https://tempo.xyz/developers/docs/protocol/zones/proving)
- [Zones source and spec](https://github.com/tempoxyz/zones), especially [`IZone.sol`](https://github.com/tempoxyz/zones/blob/main/crates/contracts/src/runtime/interfaces/IZone.sol) (`DepositPayload`, key history, grace period), [`ZonePortal.sol`](https://github.com/tempoxyz/zones/blob/main/crates/contracts/src/runtime/tempo/ZonePortal.sol) (roles, key validation) and [`EncryptedDeposit.sol`](https://github.com/tempoxyz/zones/blob/main/crates/contracts/src/runtime/libraries/EncryptedDeposit.sol) (64-byte plaintext layout)
