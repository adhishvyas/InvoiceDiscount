# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

    State your assumptions explicitly. If uncertain, ask.
    If multiple interpretations exist, present them - don't pick silently.
    If a simpler approach exists, say so. Push back when warranted.
    If something is unclear, stop. Name what's confusing. Ask.

2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

    Ask about features beyond what was asked.
    No abstractions for single-use code.
    ask about "flexibility" or "configurability" that wasn't requested.
    No error handling for impossible scenarios.
    If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

    Don't "improve" adjacent code, comments, or formatting.
    Don't refactor things that aren't broken.
    Match existing style, even if you'd do it differently.
    If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

    Remove imports/variables/functions that YOUR changes made unused.
    Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.
4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

    "Add validation" → "Write tests for invalid inputs, then make them pass"
    "Fix the bug" → "Write a test that reproduces it, then make it pass"
    "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

Write all plans that you are asked to create in the claude-plans/ folder, except chain-specific plans, which go in that chain's `<chain>/docs/plan/` folder (e.g. `tempo/docs/plan/`) so they are checked in with its docs

## Project Overview

InvoiceDiscount is an invoice discounting smart contract project, implemented separately per blockchain. Each chain lives in its own self-contained top-level folder (contracts, frontend, docs, toolchain); nothing is shared between chains, since they may support different features.

- `stellar/` — Soroban (Rust) contract workspace, React frontend, docs
- `tempo/` — Tempo implementation (in progress)
- `ethereum/` — Ethereum (Sepolia) port of the Tempo implementation, on ERC-20; Mesh Pay now is specified in `ethereum/docs/` but not built

Shared at the root: `ProjectVision.txt`, `README.md`, `claude-plans/`.

## Architecture

This is a smart contract project. When a development framework is chosen and scaffolded (e.g., Hardhat, Foundry, or Truffle for EVM-compatible chains), update this file with:

- Build, test, and deployment commands
- Contract architecture and key interfaces
- Network configuration (local, testnet, mainnet)
- Any off-chain components (frontend, backend API, indexer)


### Tempo (`tempo/`)

Toolchain: Foundry (`export PATH=$HOME/.foundry/bin:$PATH`) and pnpm via corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`). In WSL, `npm`/`npx` resolve to the Windows binaries and fail, so use the pnpm scripts.

- `tempo/contracts/`: `InvoiceFactory` deploys one EIP-1167 clone of `InvoiceEscrow` per invoice. The interface is frozen at tag `tempo-interface-v2`; changing it needs approval and a new tag.
  - `forge build`, `forge test` (unit and smoke tests; fork tests are excluded)
  - Fork tests: `TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz FOUNDRY_PROFILE=fork forge test`
  - Deploy (the user broadcasts): `forge script script/Deploy.s.sol --rpc-url https://rpc.moderato.tempo.xyz --account tempo-deployer --broadcast --verify --verifier-url https://contracts.tempo.xyz --tempo.fee-token 0x20c0000000000000000000000000000000000001`. Addresses go in `deployments/moderato.json`.
- `tempo/frontend/`: React + wagmi + Accounts SDK (Tempo Wallet). `.env` from `.env.example`.
  - `corepack pnpm dev` (http://localhost:5173), `build`, `lint`, `test`
  - `corepack pnpm sync-abi`: regenerates the ABIs in `frontend/src/abi/` and `mpp-server/src/abi/` after a contract change
- `tempo/mpp-server/`: Hono + `mppx` server for Pay now via MPP; see its [README](tempo/mpp-server/README.md). `.env` from `.env.example`.
  - `corepack pnpm dev` (port 8787), `test`, `typecheck`
  - `ALLOWED_ORIGIN` must match the frontend's origin exactly (`localhost`, not `127.0.0.1`).

Network: Moderato testnet, chain 42431, RPC `https://rpc.moderato.tempo.xyz`, explorer `https://explore.testnet.tempo.xyz`. Specs, plans and the e2e checklist are in `tempo/docs/`.

### Ethereum (`ethereum/`)

Toolchain: as Tempo (Foundry, pnpm via corepack). After a fresh clone, fetch the contract libraries: `git submodule update --init ethereum/contracts/lib/forge-std ethereum/contracts/lib/openzeppelin-contracts`.

- `ethereum/contracts/`: the Tempo contracts ported to ERC-20 (`SafeERC20`, `InvalidToken` code-size check, `invoiceRef` on the escrow events), plus native ETH invoices (`token == address(0)`). The interface is frozen at tag `ethereum-interface-v2`; changing it needs approval and a new tag.
  - `forge build`, `forge test` (unit tests; fork tests are excluded)
  - Fork tests: `SEPOLIA_RPC_URL=https://ethereum-sepolia.publicnode.com FOUNDRY_PROFILE=fork forge test`
  - Deploy (the user broadcasts): `forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --account sepolia-deployer --broadcast --verify --verifier sourcify --gas-estimate-multiplier 800`. The multiplier is required (forge underestimates Sepolia's code-storage gas). Addresses go in `deployments/sepolia.json`.
- `ethereum/frontend/`: React + wagmi, injected wallets (MetaMask). `.env` from `.env.example`, with `VITE_FACTORY_ADDRESS` and `VITE_FACTORY_DEPLOY_BLOCK` from `contracts/deployments/sepolia.json`. `src/lib/` is frozen at tag `ethereum-frontend-interface-v4`.
  - `corepack pnpm dev` (http://localhost:5173), `build`, `lint`, `test`
  - `corepack pnpm sync-abi`: regenerates `frontend/src/abi/` after a contract change

Network: Sepolia, chain 11155111, explorer `https://sepolia.etherscan.io`. The RPC must accept a 10,000-block `eth_getLogs` range (`https://ethereum-sepolia.publicnode.com` does; Alchemy's free tier doesn't). Specs, plans and the e2e checklist are in `ethereum/docs/`.
