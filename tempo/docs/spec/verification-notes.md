# Verification notes (node S1)

> Run 2026-10-19 against the Tempo docs (tempo.xyz/developers), Foundry 1.8.5, `tempo-std` v0.1.6, `wagmi` 3.7.7 / `@wagmi/connectors` 8.2.0 / `viem` 2.57.7 / `accounts` 0.21.0, and the live Moderato RPC. Each item is **confirmed**, **differs** (with the correct value) or **unknown** (with a fallback). Items marked *probed* were run, not just read.

## Summary of what changes the plan

1. **Real TIP-20 works in plain local `forge test`.** The Tempo build runs the precompiles locally (template `network = "tempo"`). A test can create a real token with `StdPrecompiles.TIP20_FACTORY.createToken(...)`, grant itself `ISSUER_ROLE` and `mint`. AlphaUSD (`0x20c…0001`) also exists locally. No fork is needed for real memo events, and `MockTIP20` is no longer necessary for the unit suite. Fork tests are still useful for OUSD and the live token set. *(Plan decision "mock + fork" should be revisited, see §S2 below.)*
2. **`isTIP20` exists on the TIP-20 Factory precompile and checks code, not just prefix.** The spec's prefix-only check lets through unused prefixed addresses.
3. **`deal` does not work on TIP-20 balances**, but `vm.prank(holder)` plus `transfer` does.
4. **The `npm` on this machine is the Windows one** and fails on WSL paths. Use `corepack pnpm@9` (works) or install a Linux Node/npm.

## Items

| # | Item | Result | Detail |
|---|---|---|---|
| 1a | TIP-20 address prefix | **confirmed** | 12-byte prefix `0x20C000000000000000000000`, then 8 bytes (`lowerBytes`). First 1024 `lowerBytes` reserved for protocol use. TIP-20 spec "Address rules" and "TIP20Factory". |
| 1b | OUSD `0x20c0…6a37da5c996874be` fits the prefix | **confirmed** | *Probed on fork:* `isTIP20(OUSD) == true`, code present. |
| 1c | Pure-prefix check vs `isTIP20` | **differs** | `TIP20_FACTORY.isTIP20(a)` ("checks the TIP-20 prefix and verifies the token has code deployed"). *Probed:* prefixed address with no code returns `false`; the DEX precompile address returns `false`. Factory address is `0x20Fc000000000000000000000000000000000000` (`StdPrecompiles.TIP20_FACTORY`). Works in local tests too. Recommend `NotTIP20` uses `isTIP20` (S2 decision). |
| 1d | Recipients with the TIP-20 prefix | **new** | TIP-20 transfers revert if the recipient is `address(0)` or has the TIP-20 prefix. So a payout or refund address that is a token address reverts at transfer time. Not handled in code (document in §3.9). |
| 2a | `tempo-std` install | **confirmed** | `forge init -n tempo` installs `forge-std` and `tempo-std` (v0.1.6) into `lib/`. Existing project: `forge install tempoxyz/tempo-std`. Import path `tempo-std/interfaces/ITIP20.sol` (no remapping needed, template has none). |
| 2b | `ITIP20` function names | **confirmed** | `transferWithMemo(address,uint256,bytes32)` **returns nothing**; `transferFromWithMemo(address,address,uint256,bytes32)` **returns bool**. `transfer`/`transferFrom` return bool. `mint(address,uint256)`, `decimals()`, `ISSUER_ROLE()`, neither `ITIP20` nor `ITIP20RolesAuth` in `tempo-std` v0.1.6 exposes `hasRole` (compile error when probed); role grant is `ITIP20RolesAuth(token).grantRole(token.ISSUER_ROLE(), who)`. |
| 2c | Memo event | **confirmed** | `event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)`, topic0 `0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0`. *Probed:* every memo transfer emits `Transfer(from,to,amount)` first, then `TransferWithMemo`. A 0-amount memo transfer also emits both. |
| 2d | Helper names | **confirmed** | `StdTokens.{PATH_USD,ALPHA_USD,BETA_USD,THETA_USD}[_ADDRESS]`, `StdPrecompiles.{TIP20_FACTORY,TIP_FEE_MANAGER,...}`. `ITIP20Factory.createToken(name,symbol,currency,quoteToken,admin,salt)`. |
| 2e | Solidity gotcha | **new** | Address literals need an EIP-55 checksum or the compile fails (e.g. OUSD is `0x20c0000000000000000000006a37DA5C996874BE`). Applies to the token list in tests and scripts. |
| 3a | `forge init -n tempo` | **confirmed** | Template: `foundry.toml` with `network = "tempo"` and `[rpc_endpoints] tempo/moderato` (pointing at `rpc.mpp.*`, replace with `rpc.moderato.tempo.xyz`), `src/Mail.sol`, `test/Mail.t.sol`, `script/Mail.s.sol`, `forge-std` v1.17.0. Default solc auto-resolves to 0.8.37, `evm_version = osaka`. |
| 3b | Local real-precompile tests | **confirmed** *(probed)* | Template tests (8) pass with no `--fork-url`. |
| 3c | Fork testing | **confirmed** *(probed)* | `forge test --fork-url https://rpc.moderato.tempo.xyz` works (head block ≈ 40.29M). |
| 3d | `foundryup -n tempo` | **differs** | Deprecated. Plain `foundryup` gives the Tempo-capable release (installed: 1.8.5). `forge init -n tempo` and `network = "tempo"` are the switches. |
| 3e | `--tempo.fee-token` | **confirmed** | Present on `forge script` / `forge create` / `cast`. Not a `forge test` flag. |
| 3f | Tempo-mode Anvil | **confirmed** | `anvil --tempo` and `anvil --tempo --fork-url …` per Foundry page (flag not executed). |
| 3g | Verification | **confirmed** | `--verify --verifier-url https://contracts.tempo.xyz` or env `VERIFIER_URL`. Sourcify-compatible; no `[etherscan]` entry. `forge verify-contract … --verifier-url …` for already-deployed code. |
| 3h | Deployer key type | **confirmed** | Contract creation needs a root key (access keys can't sign a top-level CREATE). The keystore `tempo-deployer` is a root key. |
| 4 | Funding test accounts on a fork | **differs** *(probed)* | `deal(token, who, amt)` **fails** ("No storage use detected"). Works: `vm.prank(HOLDER); token.transfer(who, amt)` where HOLDER has a balance (the funded deployer `0xA6C5…716d` held 1e12 base units). Minting needs `ISSUER_ROLE`; a random caller reverts. For tests that need isolation use locally created tokens (item summary 1). |
| 5a | `tempoWallet` export | **confirmed** | `import { tempoWallet } from 'wagmi/connectors'` (re-exported from `@wagmi/core/tempo`). Needs the `accounts` package. |
| 5b | Connector id | **confirmed** | `id` and `rdns` default to `xyz.tempo` (overridable via `rdns`). |
| 5c | `feePayer` option | **confirmed (docs)** | `tempoWallet({ feePayer: 'https://sponsor.moderato.tempo.xyz' })` or `{ feePayer: { url, precedence: 'user-first' } }`. Public sponsor needs no API key. |
| 5d | `feePayer: true` on a write | **unknown for arbitrary contract writes** | Documented for Tempo token hooks (`useTransferSync`). viem's Tempo `Transaction`/`Formatters` carry `feePayer` fields. F4 must confirm it is accepted by `sendTransactionSync`/`writeContractSync`; fallback is to encode calldata and use `sendTransactionSync({ calls, feePayer: true })`. |
| 5e | Batched calls | **confirmed (docs)** | `useSendTransactionSync().sendTransactionSync({ calls: [{to, data}, …] })` is atomic. `*Sync` variants exist in viem (`sendTransactionSync`, `writeContractSync`). |
| 5f | `tempoModerato` | **confirmed** | Exported from `viem/chains` (alias `tempoTestnet`). Chain id 42431. |
| 5g | Peer dependency | **differs** | `@wagmi/connectors` 8.2.0 / `@wagmi/core` 3.6.5 declare peer `accounts@~0.18`; npm resolves 0.21.0 (warning). `pnpm add accounts@~0.18` fails with a package-bug message. F1 must test that 0.21.0 works at runtime; fallback: pin `accounts` to the version wagmi accepts. |
| 5h | Package manager | **differs** | `npm` here is the Windows binary (`/mnt/c/Program Files/nodejs/npm`) and errors on WSL paths. `corepack pnpm@9` works (set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`). The Stellar frontend uses npm (`package-lock.json`). F1 needs a decision: pnpm, or the user installs a Linux npm. |
| 6 | `eth_getLogs` range limit | **confirmed** *(probed)* | Error: `query exceeds max block range 100000`. A request with a 100,000-block span returned a 502 (gateway), so use a **page size of 50,000 blocks**. Head ≈ 40.29M, so the deploy block matters (800 pages from genesis). |
| 7 | Network details | **confirmed** | Moderato chain 42431, RPC `https://rpc.moderato.tempo.xyz`, explorer `https://explore.testnet.tempo.xyz`, sponsor `https://sponsor.moderato.tempo.xyz`. |
| 8 | Faucet / P0 | **confirmed** *(done)* | `tempo_fundAddress` works over raw JSON-RPC; deployer `0xA6C5691eB8Fa9e84cCaB01DdAd6BD0Ce5188716d` funded with AlphaUSD (1e12 base units) and the `tempo-deployer` keystore exists. |

## Still unverified (to settle later, not blocking the freeze)

- Gas cost of `createInvoice` with the clone (spec assumes 250k gas per new slot). Measured in the gas snapshot test.
- `--verify` end to end (first real deploy, C8).
- `feePayer: true` on arbitrary contract writes (item 5d, F4).
