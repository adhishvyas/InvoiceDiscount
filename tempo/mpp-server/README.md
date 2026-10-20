# mpp-server

The HTTP server behind **Pay now via MPP** ([MPP pay-now spec](../docs/spec/mpp-pay-now-spec.md) §4). A buyer pays an Active invoice directly at the discount that applies right now. The server quotes the price as an MPP Challenge, waits for the wallet's transfer into the invoice, then calls `settleDirect()` to forward the money to the seller.

Hono + [`mppx`](https://mpp.dev) 0.13.5 + viem, on Moderato (chain 42431).

## Endpoints

| Route | Response |
|---|---|
| `GET /health` | `{"ok":true}` |
| `POST /invoices/:address/pay` | `400` bad address; `404` not a clone of `FACTORY_ADDRESS`'s implementation; `409` not Active (body names the status); `402` with the Challenge on the first request; `200` with `{ invoice, transferTx, amount, discountBps, settleTx, settled, settleError? }` and a `Payment-Receipt` header once paid |

`amount` is in token base units (6 decimals). A `200` with `settled: false` means the payment arrived but `settleDirect()` failed; the frontend then offers **Finish settlement**.

## Setup

```sh
cd tempo/mpp-server
corepack pnpm install
cp .env.example .env
```

| Variable | Value |
|---|---|
| `MPP_SECRET_KEY` | `openssl rand -hex 32`. Signs Challenges, so the server can tell its own on a retry |
| `SETTLER_PRIVATE_KEY` | A throwaway testnet key that sends `settleDirect()` and pays its fees. Fund it with `cast rpc tempo_fundAddress <address> --rpc-url https://rpc.moderato.tempo.xyz`. The server prints this address at startup |
| `FACTORY_ADDRESS` | `0x1A6934651E179448e131C453E96Ee90856b65fF8` (interface v2; see `../contracts/deployments/moderato.json`). Invoices from the v1 factory get a `404` |
| `TEMPO_RPC_URL` | `https://rpc.moderato.tempo.xyz` |
| `ALLOWED_ORIGIN` | The frontend origin, **exactly** as it appears in the browser's address bar: `http://localhost:5173` |
| `PORT` | `8787` |

The frontend reaches the server through `VITE_MPP_SERVER_URL=http://localhost:8787` in `tempo/frontend/.env`. If that is unset, Pay now is hidden.

## Commands

```sh
corepack pnpm dev        # tsx watch, reads .env
corepack pnpm start      # same, without watch
corepack pnpm test       # vitest: quote, clone check, endpoint (fake chain, no network)
corepack pnpm typecheck
```

The ABIs in `src/abi/` are generated. After a contract change, run `corepack pnpm sync-abi` in `tempo/frontend`, which writes both packages.

## Troubleshooting

- **"NetworkError when attempting to fetch resource" (Firefox) or "Failed to fetch" (Chrome) on Pay now.** The page's origin doesn't match `ALLOWED_ORIGIN`, so the browser blocks the response. `http://127.0.0.1:5173` and `http://localhost:5173` are different origins. Open the frontend at the address in `ALLOWED_ORIGIN`, or change `ALLOWED_ORIGIN` and restart the server.
- **`404` for an invoice that exists.** It was created on another factory. Check `FACTORY_ADDRESS` here and `VITE_FACTORY_ADDRESS` in the frontend.
- **`500 internal-payment-error` on the paid request.** `mppx` couldn't verify the transfer (for example, an unknown tx hash). No settlement was attempted.
- **`settled: false`.** Usually the settler has no funds for fees; `settleError` gives the reason. The payment is safe in the invoice; anyone can click **Finish settlement**.

## Limits (proof of concept)

- Replay protection uses `mppx`'s in-memory store, so run one instance. The warning printed at startup is about this.
- Concurrent pays share the settler's nonce sequence; viem's default nonce handling is relied on.
- If a `fund` lands between the quote and the transfer, the transfer goes into a Funded invoice and is stuck (spec §4.5, §7).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Reads the env, builds the clients, starts the server |
| `src/app.ts` | Hono app: CORS and routes |
| `src/pay.ts` | The pay endpoint: checks, quote, `mppx.charge`, `settleDirect()` |
| `src/quote.ts` | Smallest discount in the 180 s quote window, and the amount |
| `src/invoice.ts` | EIP-1167 clone check and `getInvoice()` |
| `src/env.ts` | Env parsing |
| `src/fakeChain.ts` | Test helper: a viem client answered from fixtures |
