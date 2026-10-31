# Verification notes (node S1)

> Run 2026-10-30 against the live Sepolia chain (public RPC `https://ethereum-sepolia.publicnode.com`, head ≈ 12.03M), Foundry 1.8.5, OpenZeppelin Contracts 5.7.0, and `wagmi` 3.7.7 / `viem` 2.57.7 as installed in `tempo/frontend/`. Each item is **confirmed**, **differs** (with the correct value) or **unknown** (with a fallback). Items marked *probed* were run on a Sepolia fork or against the RPC, not just read. Item numbers follow spec §8 and plan node S1.

## Summary of what changes the spec

1. **USDG has a Sepolia deployment** and behaves like PYUSD (Paxos contract, 6 decimals). It stays in the token list; Mesh needs it too.
2. **Alchemy's free tier can't be used** for the log scans: it caps `eth_getLogs` at 10 blocks. `LOG_PAGE_SIZE = 10_000n` fits the public node (50,000) and paid providers.
3. **`deal` works** on all three forked tokens, so the fork tests need no holder accounts.

## Items

| # | Item | Result | Detail |
|---|---|---|---|
| 1a | PYUSD on Sepolia | **confirmed** *(probed)* | `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`, `PYUSD` / "PayPal USD", 6 decimals. ZeppelinOS-slot proxy, implementation `0xc804f2e8ae84f6cfa01d9d33ef107323bf0f9a59`, owner `0x3e01…d160`. Faucet: `faucet.paxos.com` (or the Google Cloud Web3 faucet). |
| 1b | USDC on Sepolia | **confirmed** *(probed)* | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, `USDC`, 6 decimals, `version() = "2"` (FiatToken v2.x). Proxy implementation `0xda317c1d3e835dd5f1be459006471acaa1289068`. Faucet: `faucet.circle.com`. |
| 1c | USDG on Sepolia | **differs** (spec said "to confirm") *(probed)* | `0xfBb2A78CceEb415b00300925e464C3E44E6e06b0` ([Paxos docs, USDG on test networks](https://docs.paxos.com/guides/stablecoin/usdg/testnet)), `USDG` / "Global Dollar", 6 decimals. EIP-1967 proxy, implementation `0x0c8bca84208bbfcfdb97da56cdfbf9ce76b110bd`. Faucet: `faucet.paxos.com` (serves all Paxos stablecoins). **Keep it in the list.** |
| 1d | Mesh's Sepolia token contracts | **unknown** | Needs a Mesh sandbox API key (`GET /api/v1/transfers/managed/networks`). Not blocking this port. Fallback: settled in the Mesh plan's spike; if Mesh uses other contracts, the frontend token list changes (data only). |
| 2a | No transfer fee | **confirmed** *(probed)* | On a fork, `transfer(b, 123e6)` moves exactly 123e6 for PYUSD, USDC and USDG; `transferFrom` likewise. |
| 2b | Zero-amount transfers | **confirmed** *(probed)* | `transfer(b, 0)` and `transferFrom(a, b, 0)` succeed and return `true` on all three, so a 100% discount settles. |
| 2c | Pause / freeze / seizure | **confirmed** *(bytecode selectors)* | PYUSD and USDG implementations have `pause`/`unpause`, `freeze`/`unfreeze`/`isFrozen` and `wipeFrozenAddress` (issuer seizure). USDC has `pause`/`unpause` and `blacklist`/`unBlacklist`/`isBlacklisted`, no wipe. None is paused now. Matches spec §3.9 (add USDG next to PYUSD). Verified Etherscan sources not read; selectors were matched in the implementation bytecode. |
| 2d | Transfer to `address(0)` | **new** *(probed)* | Reverts on all three. Irrelevant to the contract (resolved payout/refund are never zero). |
| 3a | Public node `eth_getLogs` | **confirmed** *(probed)* | `ethereum-sepolia.publicnode.com`: 50,000-block span OK; 100,000 → `-32701 exceed maximum block range: 50000`. Some other public endpoints (`rpc.sepolia.org`, `sepolia.drpc.org`) returned Cloudflare errors from this machine. |
| 3b | Alchemy | **differs** *(docs)* | Free tier: **10-block** `eth_getLogs` range ([Alchemy eth_getLogs](https://www.alchemy.com/docs/reference/eth-getlogs), [support article](https://support.alchemy.com/articles/1883074130-why-do-i-see-a-free-tier-error-when-calling-eth-getlogs-with-a-large-block-range)). PAYG: >10,000 blocks fails if it also returns >10,000 logs. Not usable on the free tier. |
| 3c | `LOG_PAGE_SIZE` | **decision** | **`10_000n`** blocks (~1.4 days of Sepolia). Fits the public node and paid Alchemy/Infura-class providers; the scan from the deploy block stays a handful of pages for the PoC. Fallback: if the user's provider rejects it, lower it (one constant in `lib/logs.ts`). The user's choice of `VITE_RPC_URL` / `SEPOLIA_RPC_URL` is recorded in P0. |
| 4a | wagmi EIP-5792 hooks | **confirmed** *(installed types)* | wagmi 3.7.7 exports `useCapabilities`, `useSendCalls`, `useWaitForCallsStatus` (also `useCallsStatus`, `useSendCallsSync`). viem `sendCalls` has `forceAtomic?: boolean`; the capability type is `atomic: { status: 'supported' \| 'ready' \| 'unsupported' }`. |
| 4b | MetaMask on Sepolia | **confirmed (docs)**, browser probe pending | Per [MetaMask `wallet_getCapabilities`](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/wallet_getCapabilities/): `supported` = runs atomically; `ready` = would first ask the user to upgrade the account via EIP-7702; a chain with neither is **omitted** from the response (→ `undefined` in our `fundPath`). A plain EOA is therefore `ready` or absent, so it takes the **two-transaction path**; only an already-upgraded account gets `supported`. Fallback: the two-transaction path always works. The actual MetaMask response is recorded in F3's browser check and I1 step 2. |
| 5 | `deal` on forked tokens | **confirmed** *(probed)* | `deal(token, a, 1_000e6)` sets the balance for PYUSD, USDC and USDG (forge-std finds the slot behind the proxy). No holder `prank` needed. |
| 6 | OpenZeppelin and `SafeERC20` | **confirmed** | v5.7.0 (same as Tempo's `lib/`). `error SafeERC20FailedOperation(address token)`. A call that returns no data succeeds only if the token has code; one that returns `false` reverts with `SafeERC20FailedOperation(token)`; a token that reverts has its revert data bubbled up unchanged. |

## Still unverified (to settle later, not blocking the freeze)

- MetaMask's actual `wallet_getCapabilities` result on Sepolia (F3 / I1).
- Sourcify `--verify --verifier sourcify` end to end (C5).
- Mesh's Sepolia token contracts (item 1d, Mesh plan).
