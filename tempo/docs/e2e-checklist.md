# End-to-end checklist (node I1)

Manual run on Moderato (chain 42431). Spec: [`spec/invoice-discount-spec.md`](spec/invoice-discount-spec.md) §3.8 (worked example) and §4.3 (pages and actions). Record a tx hash next to every ticked item.

- Factory: `0x9e9f4Da093bFD225145396d80ca5e799e10Ce0fC`
- Implementation: `0xF0964E9A43664ca32b9890Ba21EB08f41933798A`
- Explorer: https://explore.testnet.tempo.xyz
- Frontend: `cd tempo/frontend && corepack pnpm dev` (needs `.env` with `VITE_FACTORY_ADDRESS` and `VITE_FACTORY_DEPLOY_BLOCK=40304928`)

## 0. Setup

- [ ] **Seller** account: Tempo Wallet (passkey) #1. Address: `____`
- [ ] **Buyer** account: Tempo Wallet (passkey) #2, in a separate browser profile. Address: `____`
- [ ] **Payout** address (a third address, not the seller): `____`
- [ ] **Buyer refund** address (a fourth address, not the buyer): `____`
- [ ] **MetaMask** account with Moderato added (chain 42431, RPC `https://rpc.moderato.tempo.xyz`). It needs testnet AlphaUSD **and** a fee token balance, since the user pays fees. Address: `____`
- [ ] Fund the buyer, and MetaMask: `cast rpc tempo_fundAddress <ADDR> --rpc-url https://rpc.moderato.tempo.xyz`
- [ ] Open the explorer in another tab to check memos in section 6.

**Timing plan.** Tiers need to change within minutes. For each invoice that needs a tier change, set the due date about 30 minutes out, tier 1 cutoff about 5 minutes out, and tier 2 cutoff about 15 minutes out. Note the clock times below. Use small amounts such as `100.00`.

Tier percentages for every invoice: tier 1 = 15%, tier 2 = 10%. Expected splits for 100.00 principal:

| Trigger time | Payout | Refund |
|---|---|---|
| Before tier 1 cutoff | 85.00 | 15.00 |
| After tier 1, before tier 2 cutoff | 90.00 | 10.00 |
| After the last cutoff | 100.00 | 0 |
| Cancelled after funding | 0 | 100.00 |

## 1. Create, with payout address, and duplicate block

- [ ] Connect the **seller** with Tempo Wallet on `/create`.
- [ ] Client validation blocks each invalid input: empty reference, reference over 32 UTF-8 bytes (the byte counter agrees), zero amount, due date in the past, tier cutoff after the due date, an 11th tier, a bad payout address.
- [ ] Create **INV-A** with reference `E2E-A-<date>`, 100.00 AlphaUSD, the timing plan above, and the payout address set. The transaction is **sponsored** (the seller's fee balance does not drop). Tx: `____`
- [ ] The success screen shows the reference and offers copy-address and open-invoice. INV-A address: `____`
- [ ] Go back to `/create` and enter the **same reference**. The form shows "You already have an invoice with this reference", links to INV-A, and submit is blocked.
- [ ] Reload and try the duplicate again. It is still blocked (the log scan from the deploy block works).
- [ ] The **buyer** account can use the same reference (the check is per seller). Optional, skip if short of time.
- [ ] `/invoice/<INV-A>` shows the reference prominently, seller tagged "you", the payout address, status Active, the tiers, and the active tier highlighted.

## 2. Fund, with a refund address, in one batched sponsored tx

- [ ] Connect the **buyer** and open INV-A. Fund is shown. Cancel and Trigger are not.
- [ ] Enter the buyer refund address. The pre-sign text states where the money goes.
- [ ] Click Fund. Wallet shows **one** confirmation for `approve` + `fund`, and the tx is sponsored. Tx: `____`
- [ ] The page refetches. Status is Funded, the buyer is tagged "you", and the refund address is the one entered.
- [ ] A **seller** view of INV-A shows no Fund button.

## 3. Trigger payment in tier 1, then after the cutoff

- [ ] **INV-A, before the tier 1 cutoff:** the active tier is 15%. The pre-sign text shows 85.00 to the payout address and 15.00 to the refund address. Trigger as buyer or seller. Tx: `____`
- [ ] Status is Paid. Payout balance went up by **85.00**, buyer refund balance by **15.00** (`cast call 0x20c0000000000000000000000000000000000001 "balanceOf(address)(uint256)" <ADDR>`). Before and after balances: `____`
- [ ] Create **INV-B** (same setup, new reference), fund it with the buyer, and **wait until after the tier 1 cutoff but before the tier 2 cutoff**. The highlighted tier switches to 10%.
- [ ] Trigger INV-B. Split is **90.00 / 10.00**, matching `activeDiscount`. Tx: `____`
- [ ] Optional: **INV-C** triggered after the last cutoff pays **100.00 / 0**, and no refund transfer is made. Tx: `____`
- [ ] A Paid invoice shows no action buttons.

## 4. Cancel paths

- [ ] **INV-D**, unfunded: the seller cancels. Status is Cancelled. Tx: `____`
- [ ] **INV-E**, funded by the buyer: the seller cancels. The buyer's refund address receives the full **100.00**, and the payout address receives nothing. Tx: `____`
- [ ] **INV-F**, funded, **before the due date:** the buyer sees **no** Cancel button. If forced through a direct contract call, it reverts (`cast send <INV-F> "cancel()" ...` from the buyer's key, optional).
- [ ] **INV-F, after the due date:** the buyer's Cancel appears, and cancelling returns the full 100.00 to the refund address. Tx: `____` (this needs an invoice with a short due date, for example 10 minutes)
- [ ] A stranger (neither seller nor buyer) sees no Trigger or Cancel buttons.

## 5. MetaMask repeat (two txs, user pays fees)

- [ ] Connect MetaMask through the "other wallet" option. The fee note for injected wallets is shown.
- [ ] Create **INV-G** as MetaMask-seller. A single write, with fees paid by the user. Tx: `____`
- [ ] Fund **INV-G** with a second MetaMask-style buyer account or the same one on a separate invoice. The UI sends `approve`, then `fund`: **two** confirmations. Txs: `____` / `____`
- [ ] Trigger INV-G. Split matches the active tier. Tx: `____`
- [ ] The wallet's fee balance went down for each tx (unlike the sponsored ones).

## 6. Memos on the explorer

For every transfer listed, open the tx and check the `TransferWithMemo` event. The memo, decoded from bytes32, equals the **invoice reference** exactly.

- [ ] INV-A fund (buyer → escrow)
- [ ] INV-A payout (escrow → payout address)
- [ ] INV-A refund (escrow → buyer refund address)
- [ ] INV-B payout and refund
- [ ] INV-E cancel refund (escrow → buyer refund address)
- [ ] INV-F cancel refund
- [ ] INV-G fund, payout and refund (MetaMask path)
- [ ] INV-C has **no** refund transfer (zero discount)

## 7. Wrap-up

- [ ] Browser console has no unexpected errors during the run.
- [ ] Notes on anything surprising (wallet UX, sponsor failures, RPC errors): `____`
- [ ] Every box above is ticked with a tx hash. Then mark I1 completed in [`plan/implementation-dag.md`](plan/implementation-dag.md) and move on to D1.
