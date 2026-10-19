# Invoice detail: lifecycle history and payout breakdown

> Written 2026-10-19. Scope: `tempo/frontend/src/pages/InvoiceDetail.tsx`. No contract change, no database.

## Question: can this come from the chain, or do we need a database?

**Everything requested can be read from the chain. No local database is needed.**

The deployed contracts already emit one event per lifecycle step, and each event carries the amounts and addresses:

| Wanted | Source | Notes |
|---|---|---|
| Created: when, by whom, tx | Factory `InvoiceCreated(invoice indexed, seller indexed, invoiceRef indexed, token, principal, dueDate)` | Filter by the `invoice` topic. Block timestamp gives "when" |
| Funded: when, buyer, refund address, tx | Escrow `Funded(buyer indexed, refundAddress, principal)` | |
| Paid: when, who triggered, tx | Escrow `Paid(caller indexed, ...)` | |
| Paid: amount to seller, amount to buyer, both addresses, discount applied | Same `Paid` event: `payoutAddress`, `toSeller`, `refundAddress`, `refundToBuyer`, `discountBps` | Recorded at execution time, so it stays correct even though `activeDiscount` changes with the clock |
| Cancelled: when, who, amount refunded, tx | Escrow `Cancelled(caller indexed, refunded)` | `refunded` is 0 when cancelled before funding |

Not in the events themselves, but derived:

- **Timestamps.** Events carry no timestamp. Each log has `blockNumber`; `getBlock(blockNumber).timestamp` gives the time. One extra RPC per event (at most 3 per invoice).
- **Tx hash.** On every log, so each row can link to the explorer.
- **Discount in cash.** `principal - toSeller - refundToBuyer` is 0 by construction; the "discount" shown is `refundToBuyer`, with `discountBps` as the percentage.
- **Which tier applied.** Match `discountBps` against `inv.tiers`, or just show the percentage. The percentage is enough.

What would need a database: anything not on-chain, e.g. buyer or seller names, a PDF of the invoice, notes. Nothing requested here is of that kind. The contract stores only the 32-byte reference, so such data is out of scope until someone asks for it.

**Why not change the contract to store timestamps?** The interface is frozen (`tempo-interface-v1`) and deployed to Moderato. The events plus block timestamps already give the same information, so a redeploy buys nothing.

## The one real cost: finding where to start reading logs

The Moderato RPC rejects `eth_getLogs` ranges over 100,000 blocks (we page at 50,000, see `LOG_PAGE_SIZE` in `lib/logs.ts`). Filtering by the invoice's own address makes each page cheap but we still need a start block.

- **Approach:** page through the factory for `InvoiceCreated` with `args: { invoice }`, starting at `FACTORY_DEPLOY_BLOCK`, exactly as `findExistingInvoice` already does. The hit gives the creation block. Then read `Funded` / `Paid` / `Cancelled` from the invoice address, from the creation block to latest, in one pass of pages.
- **Cost:** `(head - deployBlock) / 50,000` pages for the factory scan. Small today, grows with chain age.
- **Mitigation:** cache the result in `localStorage` keyed by invoice address. The creation block never changes, and a terminal event (`Paid` / `Cancelled`) never changes once seen. This is a per-viewer speed-up only; the page must work with it empty.
- **Rejected: binary search on `eth_getCode`** to find the creation block. It needs historical state on the RPC node, which is unverified.

## Design

### 1. `lib/history.ts` (new, pure + one fetch function)

```ts
export type InvoiceHistory = {
  created?: { timestamp: bigint; tx: Hex; seller: Address };
  funded?: { timestamp: bigint; tx: Hex; buyer: Address; refundAddress: Address; principal: bigint };
  paid?: { timestamp: bigint; tx: Hex; caller: Address; payoutAddress: Address; toSeller: bigint;
           refundAddress: Address; refundToBuyer: bigint; discountBps: number };
  cancelled?: { timestamp: bigint; tx: Hex; caller: Address; refunded: bigint };
};
```

- `fetchInvoiceHistory(client, factory, deployBlock, invoice)`: factory scan, invoice scan, then `getBlock` per event (deduplicated by block number).
- A pure `buildHistory(logs, timestamps)` does the mapping so it can be unit-tested without an RPC, matching how `logs.test.ts` tests `blockRanges`.
- Reuse `blockRanges` and `LOG_PAGE_SIZE` from `lib/logs.ts`.

### 2. `useInvoiceHistory` hook

`useQuery` (wagmi already pulls in TanStack Query) keyed on `[invoice, status]`. Keying on `status` refetches after `fund` / `triggerPayment` / `cancel` succeed, since the page already calls `refetch()` on `getInvoice` after each write. Disabled when `FACTORY_ADDRESS` or `FACTORY_DEPLOY_BLOCK` is undefined (the page then shows the current view without history).

### 3. UI in `InvoiceDetail.tsx`

- **Timeline section** below the parties card: Created → Funded → Paid or Cancelled. Each row: label, local date-time (reuse `formatDate`), actor (`Party`-style short address with "you" badge), and an explorer link to the tx. Future steps shown greyed as "Not yet".
- **Settlement section** (only when Paid): table of
  - Seller payout: `toSeller` → `payoutAddress`
  - Buyer refund (discount): `refundToBuyer` → `refundAddress`, with `discountBps` as a percentage
  - Total = `principal`
  - Triggered by `caller`, and whether that was before or after the due date.
- **Cancellation line** (only when Cancelled): `refunded` → refund address, or "No funds moved" when `refunded == 0`. Shows who cancelled.
- The existing "If paid now" box keeps showing only while the invoice is open; once settled, the Settlement section replaces it.
- Header: add "Funded on …" / "Paid on …" next to the due date only if cheap; otherwise the timeline covers it.

### 4. Failure handling

History is secondary to the invoice itself. If the log scan fails, show the existing page plus a small "History unavailable, retry" note. Do not block `getInvoice` rendering on it.

## Steps

1. **Pure mapper** `buildHistory` + unit tests with hand-made logs (each of the four event shapes; cancelled-before-funding; missing events). → verify: `pnpm test` passes.
2. **Fetch function** `fetchInvoiceHistory` using the existing paging. → verify: run against the real Moderato invoice(s) from `docs/e2e-checklist.md` in a throwaway script; amounts and timestamps match the explorer.
3. **Hook** `useInvoiceHistory` with `localStorage` cache wrapped in try/catch. → verify: second load of the same invoice makes no factory-scan requests (network tab).
4. **Timeline + Settlement UI.** → verify in the browser for each of: Active, Funded, Paid with a discount, Paid with no discount (`refundToBuyer == 0`), Cancelled while Funded, Cancelled while Active.
5. **Update** `docs/e2e-checklist.md` with the history checks, and `CLAUDE.md` if it lists frontend modules. → verify: checklist run end to end on Moderato.

## Open questions

1. **Block timestamps resolution.** I assume `getBlock().timestamp` is in seconds like the rest of the code (`dueDate`, `cutoff`). Tempo may expose a finer-grained timestamp too; step 2 will check, and seconds are enough here.
2. **Pre-existing invoices.** *Resolved:* no invoices were created before `FACTORY_DEPLOY_BLOCK`, so the factory scan from that block finds every invoice. No special handling is needed.
3. **TIP-20 transfer events.** Each payout also emits a token-level transfer-with-memo event. I'm not reading them, since the escrow's `Paid` event already has the same amounts. They'd only matter as an independent cross-check; say if you want that.
4. **Scope of "etc."** I've included who created / funded / triggered / cancelled, and the discount percentage. Tell me if you want more, such as time-to-due-date at payment or the funding duration.
