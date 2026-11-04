# End-to-end checklist (node I1)

Manual run on Sepolia (chain 11155111), ported from [`tempo/docs/e2e-checklist.md`](../../tempo/docs/e2e-checklist.md). Spec: [`spec/invoice-discount-spec.md`](spec/invoice-discount-spec.md) §3.5 (functions), §5.2 (funding path) and §5.3 (pages and actions). Record a tx hash next to every ticked item.

- Factory: `0x58B4989074B20af8331C048D7535c70f534299d4`
- Implementation: `0x1619ba96564c733204173cC201f1B9D3Ab9280d1`
- Deploy block: `12056811` (see `contracts/deployments/sepolia.json`)
- Explorer: https://sepolia.etherscan.io
- Frontend: `cd ethereum/frontend && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm dev`, with `.env`:
  ```
  VITE_RPC_URL=https://ethereum-sepolia.publicnode.com
  VITE_FACTORY_ADDRESS=0x58B4989074B20af8331C048D7535c70f534299d4
  VITE_FACTORY_DEPLOY_BLOCK=12056811
  ```
  Restart `pnpm dev` after editing `.env`; Vite reads it only at startup.

Tokens: PYUSD `0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`, USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Balance check:
`cast call <TOKEN> "balanceOf(address)(uint256)" <ADDR> --rpc-url https://ethereum-sepolia.publicnode.com` (6 decimals: `8500000` = 8.50).

## 0. Setup

- [ ] **Seller**: MetaMask account #1, with Sepolia ETH. Address: `____`
- [ ] **Buyer**: MetaMask account #2, with Sepolia ETH, about **70 PYUSD** and **10 USDC**. Address: `____`
- [ ] **Payout** address (account #3, not the seller; needs no ETH): `____`
- [ ] **Buyer refund** address (account #4, not the buyer; needs no ETH): `____`
- [ ] **Stranger** (any other account, or the seller/buyer on an invoice they aren't part of) for the "no buttons" checks.
- [ ] Note before balances of PYUSD for the payout and refund addresses: `____` / `____`

**Timing plan.** For each invoice that needs a tier change, set the due date about 30 minutes out, tier 1 cutoff about 5 minutes out, and tier 2 cutoff about 15 minutes out. Sepolia blocks are 12 s, so leave a minute of margin around each cutoff. Note the clock times below.

Amounts are **10.00** (the faucets give small amounts). Tiers for every invoice: tier 1 = 15%, tier 2 = 10%. Expected splits:

| Trigger time | Payout | Refund |
|---|---|---|
| Before tier 1 cutoff | 8.50 | 1.50 |
| After tier 1, before tier 2 cutoff | 9.00 | 1.00 |
| After the last cutoff | 10.00 | 0 |
| Cancelled after funding | 0 | 10.00 |

## 1. Wallet, chain and gas (F3 browser checks)

- [ ] `/` shows a single "Connect wallet" button and the Sepolia ETH note with the faucet link.
- [ ] With MetaMask on another network (e.g. Ethereum mainnet), connecting shows "Switch to Sepolia", and write buttons are disabled. Clicking it switches MetaMask to Sepolia.
- [ ] Disconnect, then reconnect. The address shown follows the MetaMask account selected.
- [ ] Record what MetaMask reports for the buyer. In the browser console on the app's page: `await ethereum.request({ method: 'wallet_getCapabilities', params: ['<BUYER>', ['0xaa36a7']] })`. Result: `____` (expected: `atomic.status` `ready`, or no `0xaa36a7` key, so the fund path is **two transactions**; see verification-notes item 4b).
- [ ] With an account that has **no Sepolia ETH** (e.g. the payout account), try to create an invoice. The error reads "You need Sepolia ETH to pay gas".

## 2. Create, with payout address, and duplicate block

- [ ] Connect the **seller** on `/create`. The token dropdown lists PYUSD (selected), USDC and USDG.
- [ ] Client validation blocks each invalid input: empty reference, reference over 32 UTF-8 bytes (the byte counter agrees), zero amount, due date in the past, tier cutoff after the due date, an 11th tier, a bad payout address.
- [ ] Create **INV-A** with reference `E2E-A-<date>`, 10.00 PYUSD, the timing plan, and the payout address set. The tx hash with an Etherscan link shows while pending. Tx: `____`
- [ ] The success screen shows the reference and offers copy-address and open-invoice. INV-A address: `____`
- [ ] Back on `/create`, enter the **same reference**. The form shows "You already have an invoice with this reference", links to INV-A, and submit is blocked.
- [ ] Reload and try the duplicate again. Still blocked (the log scan from the deploy block works).
- [ ] Optional: the **buyer** can use the same reference (the check is per seller).
- [ ] `/invoice/<INV-A>` shows the reference prominently, seller tagged "you", the payout address, status Active, the tiers, and the active tier highlighted.

## 3. Fund, with a refund address

- [ ] Connect the **buyer** and open INV-A. Fund is shown; Cancel and Trigger payment are not.
- [ ] Enter the buyer refund address. The pre-sign text states where the money goes.
- [ ] Click Fund. On the two-transaction path MetaMask asks **twice**: `approve` (spending cap 10 PYUSD to INV-A), then, after it confirms, `fund`. Txs: `____` / `____`
- [ ] The page refetches. Status is Funded, the buyer is tagged "you", and the refund address is the one entered.
- [ ] The **seller** view of INV-A shows no Fund button.
- [ ] Optional, **batched path**: switch the buyer to a MetaMask smart account (Settings → Account details → "Switch to smart account", which upgrades it via EIP-7702), re-run the console check (now `supported`), and fund a fresh invoice. MetaMask shows **one** confirmation for `approve` + `fund`. Tx: `____`. Skip if the option isn't offered.

## 4. Trigger payment in tier 1, then after the cutoff

- [ ] **INV-A, before the tier 1 cutoff:** active tier is 15%. The pre-sign text shows 8.50 to the payout address and 1.50 to the refund address. If the cutoff is under 5 minutes away, the warning "A discount tier ends at hh:mm…" is shown. Trigger as buyer or seller. Tx: `____`
- [ ] Status is Paid. Payout balance went up by **8.50**, refund balance by **1.50**. Balances after: `____`
- [ ] Create **INV-B** (same setup, new reference), fund it as the buyer, and **wait until after the tier 1 cutoff, before the tier 2 cutoff**. The highlighted tier switches to 10%.
- [ ] Trigger INV-B. Split is **9.00 / 1.00**, matching `cast call <INV-B> "activeDiscount(uint64)(uint16)" $(date +%s) --rpc-url …` (= 1000). Tx: `____`
- [ ] Optional: **INV-C** triggered after the last cutoff pays **10.00 / 0**, with no transfer to the refund address. Tx: `____`
- [ ] A Paid invoice shows no action buttons.

## 5. Cancel paths

- [ ] **INV-D**, unfunded: the seller cancels. Status Cancelled. Tx: `____`
- [ ] **INV-E**, funded: the seller cancels. The refund address receives the full **10.00**, the payout address nothing. Tx: `____`
- [ ] **INV-F** (due date about 10 minutes out), funded, **before the due date**: the buyer sees **no** Cancel button.
- [ ] **INV-F, after the due date**: the buyer's Cancel appears; cancelling returns 10.00 to the refund address. Tx: `____`
- [ ] A stranger sees no Trigger payment or Cancel buttons.

## 6. Direct settlement (`settleDirect`)

- [ ] **INV-G**, Active (not funded). From the buyer, send the **amount due now** in PYUSD straight to the INV-G address (MetaMask → Send → PYUSD → paste INV-G). Before tier 1's cutoff that is 8.50. Tx: `____`
- [ ] After a refetch, Finish settlement is shown (to the seller, the buyer and a stranger), and Fund still is too. Click Finish settlement. Status Paid; the payout address received 8.50. Tx: `____`
- [ ] History shows the buyer's inbound transfer (sender, amount), then "Settled directly" with the discount tier.
- [ ] **INV-H**, Active. Send **5.00** PYUSD to it. Tx: `____`
- [ ] The **seller** sees Accept and settle (not Finish settlement), with "You will receive 5.00 PYUSD instead of 8.50 …". The buyer sees neither settle action.
- [ ] The seller accepts. Status Paid; the payout address received 5.00. Tx: `____`

## 7. USDC repeat

- [ ] Create **INV-U** in USDC, 10.00, same tiers. Tx: `____`
- [ ] Fund as the buyer (two confirmations). Txs: `____` / `____`
- [ ] Trigger. Split matches the active tier, paid in USDC (check with the USDC address in the balance command). Tx: `____`

## 8. `invoiceRef` on Etherscan

For each tx, open the **Logs** tab. The escrow event's `invoiceRef` (topic 2 on all four events; topic 1 is the caller or buyer) decodes to the invoice reference: `cast parse-bytes32-string <topic>`. The ERC-20 `Transfer` logs show the amounts and recipients.

- [ ] INV-A `Funded` and `Paid` (with `Transfer`s to payout and refund)
- [ ] INV-B `Paid`
- [ ] INV-E and INV-F `Cancelled` (one `Transfer` of 10.00 to the refund address)
- [ ] INV-G and INV-H `SettledDirect`
- [ ] INV-U `Funded` and `Paid` (USDC)
- [ ] INV-C has **no** refund `Transfer` (zero discount)
- [ ] The INV-A clone address page on Etherscan shows it as a minimal proxy of the implementation.

## 9. Wrap-up

- [ ] History on each invoice page shows every step above, with timestamps.
- [ ] Browser console has no unexpected errors during the run.
- [ ] Notes (wallet UX, RPC errors, gas costs): `____`
- [ ] Every box above is ticked with a tx hash. Then mark I1 completed in [`plan/implementation-dag.md`](plan/implementation-dag.md), record the `wallet_getCapabilities` result in [`spec/verification-notes.md`](spec/verification-notes.md) item 4b, and move on to D1.
