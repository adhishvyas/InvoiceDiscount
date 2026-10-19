# Reading the Deploy Output, Line by Line

> Written October 2026. A walk through the terminal output of the first Moderato testnet deployment of `InvoiceFactory` (and, inside it, the `InvoiceEscrow` implementation), with `forge script script/Deploy.s.sol`. Each block of output is quoted, then explained. Figures were checked against `contracts/broadcast/Deploy.s.sol/42431/run-latest.json`.

## TL;DR

- `forge script` works in two phases. First it **simulates** the script locally to see which transactions it would send. Then, because of `--broadcast`, it **signs and sends** those transactions for real.
- The script sent **one transaction**. That single transaction deployed **two contracts**: the factory, and the escrow implementation that the factory's constructor creates.
- It cost **≈ $0.0044 in AlphaUSD** (7,213,176 gas at 0.60475625 gwei), paid in a stablecoin because Tempo has no native gas token.
- Both contracts were then **verified on Sourcify** (Tempo's verifier at `contracts.tempo.xyz`) with an **exact match**, so anyone can read the source code behind the bytecode on-chain (see §6.1 for how).
- The deployed addresses:
  - `InvoiceFactory`: `0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC`
  - `InvoiceEscrow` implementation: `0xF0964E9A43664ca32b9890Ba21EB08f41933798A`

---

## 1. The command

```
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --account tempo-deployer \
  --broadcast \
  --verify --verifier-url https://contracts.tempo.xyz \
  --tempo.fee-token 0x20c0000000000000000000000000000000000001
```

| Part | Meaning |
|---|---|
| `forge script script/Deploy.s.sol` | Run the Solidity script `Deploy`. Its `run()` function does `new InvoiceFactory()` between `vm.startBroadcast()` and `vm.stopBroadcast()`. Every state-changing call made in that window becomes a real transaction. |
| `--rpc-url https://rpc.moderato.tempo.xyz` | The node to talk to: Tempo's **Moderato testnet**. Forge reads chain state from it during the simulation and sends the transactions to it. |
| `--account tempo-deployer` | Sign with the encrypted keystore named `tempo-deployer` (stored under `~/.foundry/keystores/`, created earlier with `cast wallet import`). The private key never appears on the command line or in shell history. |
| `--broadcast` | Actually send the transactions. Without it, forge only simulates (a "dry run"). |
| `--verify --verifier-url https://contracts.tempo.xyz` | After deploying, upload the source code to Tempo's contract verifier so that block explorers can show it. |
| `--tempo.fee-token 0x20c0…0001` | A Tempo-only flag in the Tempo build of Foundry. Tempo has no native coin for gas, so fees are paid in a USD stablecoin (a TIP-20 token). This chooses **AlphaUSD**, the testnet stablecoin that the deployer was funded with from the faucet. |

---

## 2. Compiling

```
[⠊] Compiling...
No files changed, compilation skipped
```

Forge checks whether any source file has changed since the last build. Nothing had, so it reuses the compiled artefacts already in `contracts/out/`. The compiler settings come from `foundry.toml`: solc `0.8.37`, optimizer on, 200 runs.

```
Enter keystore password:
```

Forge needs to decrypt the `tempo-deployer` keystore to get the private key it will sign with. The password is typed in privately and is not echoed.

---

## 3. The simulation

```
Script ran successfully.
```

This is **phase one**. Forge has run `Deploy.run()` on its own local EVM, using a copy of Moderato's current state read through the RPC. Nothing has gone on-chain yet. The run tells forge which transactions it *would* send and what they would do.

```
== Return ==
factory: contract InvoiceFactory 0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC
```

`run()` is declared `returns (InvoiceFactory factory)`, and forge prints the return value. The address is known before anything is sent because a contract address created with `CREATE` depends only on **the deployer's address and its nonce**. The simulation used the deployer's real nonce, so the address it predicts is the one the real transaction gets.

```
== Logs ==
  InvoiceFactory: 0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC
  Implementation: 0xF0964E9A43664ca32b9890Ba21EB08f41933798A
```

These are the two `console.log` lines at the end of `run()`. The second one reads `factory.implementation()`. The factory's constructor runs `implementation = address(new InvoiceEscrow())`, so the escrow implementation is deployed **by the factory, inside the same transaction**. Its address depends on the factory's address and the factory's own nonce (1, its first deployment). Every invoice will later be a cheap `Clones.clone(implementation)` of this contract.

---

## 4. The gas estimate

```
## Setting up 1 EVM.
```

Scripts can broadcast to several chains at once. This one uses one chain, so forge sets up one EVM connection.

```
Chain 42431
```

`42431` is the chain ID of Tempo Moderato. Forge uses it to sign the transactions (so that they can't be replayed on another chain) and to name the output folders (`broadcast/Deploy.s.sol/42431/`).

```
Estimated max fee per gas: 1.20475625 gwei
Estimated base fee per gas: 0.6 gwei
Estimated max priority fee per gas: 0.00475625 gwei
```

These are EIP-1559 fee fields:

- **Base fee** (0.6 gwei): the price per unit of gas that the network currently charges everyone. It is burned or kept by the protocol, not paid to the block producer.
- **Priority fee** (0.00475625 gwei): a tip to the block producer. Forge asked the node what tip is currently normal.
- **Max fee** (1.20475625 gwei): the most the deployer agrees to pay per gas. Forge sets it to `2 × base fee + priority fee` (2 × 0.6 + 0.00475625), which leaves room in case the base fee rises before the transaction is included. You pay only `base fee + priority fee`, not the max.

"gwei" here is a unit of 10⁻⁹. Tempo prices gas in its USD fee token rather than in ETH, but forge keeps the familiar Ethereum labels.

```
Estimated total gas used for script: 9377128
```

The simulation measured **7,213,176 gas** (the same figure as the real transaction below). Forge multiplies that by its default safety margin of 130% (`--gas-estimate-multiplier`) and uses the result as the transaction's gas limit: 7,213,176 × 1.3 ≈ 9,377,128. Unused gas is not charged.

The amount is high (an ordinary token transfer is around 50,000) because one transaction stores the bytecode of **two** contracts, and storing contract code costs gas per byte.

```
Estimated amount required: 0.01129715356505 AlphaUSD
```

The worst case: gas limit × max fee = 9,377,128 × 1.20475625 gwei ≈ 0.0113 AlphaUSD. Forge checks that the deployer holds at least this much of the fee token before it sends anything.

---

## 5. Sending the transaction

```
⠐ Sequence #1 on tempo-moderato | Sending transactions [0 - 0]
⠁ [00:00:00] [-------------------------------------] 0/1 txes (0.0s)
```

This is **phase two**: the real broadcast. A *sequence* is the batch of transactions for one chain. `[0 - 0]` means it sends transactions from index 0 to index 0, in other words just one. `0/1 txes` is the progress bar before the transaction has been confirmed.

There is only one transaction even though two contracts appear. The escrow implementation is created by a `CREATE` *inside* the factory's constructor, which is an internal call, not a transaction of its own. (It shows up in `run-latest.json` under `additionalContracts`.)

```
##### tempo-moderato
✅  [Success] Hash: 0xf5f931e5a7e552c0d310898ea241de3cc92162835cc7dc97d4979fb7c75c2a94
Contract: InvoiceFactory
Contract Address: 0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC
Block: 40304928
Paid: 0.00436221326835 USD (7213176 gas * 0.60475625 gwei)
```

(In the terminal these lines run together on one wide line because of how the progress bar redraws. They are separate fields.)

| Field | Meaning |
|---|---|
| `[Success]` | The receipt has status 1: the transaction was included and did not revert. |
| `Hash` | The transaction's ID. Look it up on the explorer, or run `cast receipt 0xf5f9…2a94 --rpc-url $TEMPO_RPC_URL`. |
| `Contract` / `Contract Address` | The contract created by the transaction's top-level `CREATE`, which matches the simulated address. |
| `Block: 40304928` | The block that included it. This is the **deploy block**: an indexer or frontend that scans for factory events should start from here. |
| `Paid` | Gas actually used × effective gas price. 7,213,176 × 0.60475625 gwei = 0.00436 AlphaUSD, under half a US cent. The effective price is base fee + tip (0.6 + 0.00475625). The receipt shows transaction type `0x76`, Tempo's own transaction type, which is what carries the `feeToken` field. |

Note that the estimate line says "AlphaUSD" and the paid line says "USD". Both refer to the same token. The labels just come from different parts of forge's Tempo support.

```
✅ Sequence #1 on tempo-moderato | Total Paid: 0.00436221326835 USD (7213176 gas * avg 0.60475625 gwei)
```

The total for the whole sequence. With one transaction it equals that transaction's cost. "avg" matters only when a sequence has several transactions at different prices.

```
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
```

Every transaction is confirmed. The contracts are live. Everything after this line is verification, which does not change the chain.

---

## 6. Verification

Verification proves that the bytecode at an address was compiled from a particular piece of source code. The verifier recompiles the source with the same settings and compares the result with what is on-chain. After that, explorers show the readable source and ABI, and anyone can check that the contract does what it claims.

```
Start verification for (2) contracts
```

Forge verifies every contract the script created: the factory and the implementation that the factory deployed.

```
Start verifying contract `0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC` deployed on tempo-moderato
EVM version: osaka
Compiler version: 0.8.37
Optimizations:    200
```

The settings the verifier must reproduce exactly. Any difference changes the bytecode and the verification fails.

- **EVM version `osaka`**: the hard fork that the compiler targeted (the latest Ethereum fork, which Tempo supports). It decides which opcodes the compiler may emit.
- **Compiler `0.8.37`**: pinned in `foundry.toml` via `solc = "0.8.37"`.
- **Optimizations 200**: optimizer on, tuned for a contract whose functions are expected to be called around 200 times. A lower number favours smaller deployment code, a higher number favours cheaper calls.

```
Verifying on sourcify...
Submitting verification for [InvoiceFactory] 0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC.
Submitted contract for verification:
        Verification Job ID: `e3ee57eb-0453-4e3b-9d98-ed2b2032479a`
        URL: https://contracts.tempo.xyz/verify-ui/jobs/e3ee57eb-0453-4e3b-9d98-ed2b2032479a
```

Tempo's verifier at `contracts.tempo.xyz` speaks the **Sourcify** API, an open, decentralised verification service (as opposed to Etherscan's closed one). Forge uploads the source files and compiler metadata. The verifier queues a job and returns its ID. The URL shows the job's status in a browser.

```
Waiting for sourcify verification result...
Warning: Verification is still pending...; waiting 5 seconds before trying again (4 tries remaining)
Warning: Verification is still pending...; waiting 5 seconds before trying again (3 tries remaining)
```

Recompiling takes a few seconds, so forge polls every 5 seconds. These "warnings" are only status messages, not problems. It would have given up after five tries. It needed three.

```
Contract successfully verified:
Status: `exact_match`
```

Sourcify has two levels of match:

- **`exact_match`** (also called a *full* or *perfect* match): the bytecode matches **and** so does the metadata hash that solc appends to the end of the bytecode. That hash covers the source files byte for byte, including comments and file names. So this is the exact source that was deployed.
- **`match`** (a *partial* match): the executable code matches, but the metadata differs, for example because a comment or whitespace changed. The logic is the same, but the files are not byte-for-byte the originals.

`exact_match` is the best possible result. It describes the **runtime** code, the code that lives at the address and runs when someone calls the contract. Sourcify also compares the **creation** code, which includes the constructor and runs only once at deploy time. For the factory, the verifier's API reports `runtimeMatch: exact_match` but `creationMatch: match`. The creation code's executable part matches but its metadata differs. The code people actually call is an exact match, so this doesn't weaken the guarantee.

```
Start verifying contract `0xF0964E9A43664ca32b9890Ba21EB08f41933798A` deployed on tempo-moderato
...
Submitting verification for [InvoiceEscrow] 0xF0964E9A43664ca32b9890Ba21EB08f41933798A.
...
Contract successfully verified:
Status: `exact_match`
All (2) contracts were verified!
```

The same steps for the `InvoiceEscrow` implementation. This matters for users: each invoice clone is a minimal proxy that forwards every call to this implementation. Explorers can tell this from the clone's bytecode, so once the implementation is verified, people can read the code that actually runs every invoice.

### 6.1 How to read the verified source

The source is held by Tempo's verifier at `contracts.tempo.xyz`. It is **not** on the public `sourcify.dev`, which has nothing for chain 42431.

**Block explorer.** Open the address in the testnet explorer, for example `https://explore.testnet.tempo.xyz/address/0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC`. Explorers usually show verified source on a "Contract" or "Code" tab.

**Verifier API.** The verifier uses the Sourcify v2 API, so you can fetch the source with `curl`:

```bash
ADDR=0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC   # or the implementation, 0xF0964E9A43664ca32b9890Ba21EB08f41933798A
API=https://contracts.tempo.xyz/v2/contract/42431/$ADDR

# Match status (match, runtimeMatch, creationMatch, verifiedAt)
curl -s $API

# List the verified source files
curl -s "$API?fields=sources" | jq -r '.sources | keys[]'

# Print one file
curl -s "$API?fields=sources" | jq -r '.sources["src/InvoiceFactory.sol"].content'
```

For the factory this lists 20 files: `src/InvoiceFactory.sol`, `src/InvoiceEscrow.sol`, and the OpenZeppelin and tempo-std library files they import. Other fields work the same way, for example `?fields=abi` or `?fields=all`.

**Check it yourself.** Verification is trustworthy because anyone can repeat it. Compile the returned source with the compiler settings the API returns, and compare the result with the code on-chain: `cast code $ADDR --rpc-url $TEMPO_RPC_URL`.

---

## 7. The files forge wrote

```
Transactions saved to: .../tempo/contracts/broadcast/Deploy.s.sol/42431/run-latest.json
```

A full record of the deployment: the signed transactions, their receipts, the deployed addresses (including `additionalContracts` for the implementation), and the commit hash. `run-latest.json` is overwritten on each run, and a timestamped copy (`run-<timestamp>.json`) is kept next to it. The project's `.gitignore` keeps `broadcast/` for real networks and ignores only local-chain (`31337`) and `dry-run` output, so this folder is meant to be committed as the record of the deployment. At the moment it is untracked.

```
Sensitive values saved to: .../tempo/contracts/cache/Deploy.s.sol/42431/run-latest.json
```

Values that should not be shared, mainly the RPC URL (which for some providers contains an API key) and similar settings. They are kept apart from the broadcast record so that the broadcast file can be committed safely. `cache/` is gitignored.

---

## Quick reference

| What | Value |
|---|---|
| Network | Tempo Moderato testnet, chain ID `42431` |
| `InvoiceFactory` | `0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC` |
| `InvoiceEscrow` implementation | `0xF0964E9A43664ca32b9890Ba21EB08f41933798A` |
| Deploy transaction | `0xf5f931e5a7e552c0d310898ea241de3cc92162835cc7dc97d4979fb7c75c2a94` |
| Deploy block | `40304928` |
| Gas used | 7,213,176 |
| Fee paid | 0.00436221326835 AlphaUSD |
| Verification | Sourcify `exact_match` for both contracts (runtime code), on `contracts.tempo.xyz` |
