# Spec questions (node U1)

Where the spec (`ethereum/docs/spec/invoice-discount-spec.md` §5) and the TSDoc in `src/lib/` disagree or are silent, the tests follow the reading below and carry a `// SPEC-QUESTION n` marker.

1. **`finishSettlement` with a zero amount due and a zero balance.** Spec §5.3 says "clone balance >= amount due now", which is true for `0 >= 0` (a 100% discount tier is active and nothing has arrived). The TSDoc of `visibleActions` adds `0 < cloneBalance`. Tested reading: the TSDoc (false when `cloneBalance` is 0), since the contract reverts with `NothingToSettle` on an empty invoice. Marker: `actions.test.ts`.
2. **Address casing in `fetchInvoiceHistory` output.** The TSDoc does not say whether addresses in the history are checksummed (what viem's decoded logs give) or lowercased. Tested reading: whatever viem decodes, i.e. EIP-55 checksummed; the fixtures use `getAddress(...)`. Marker: `fetch.test.ts`.
3. **`friendlyError` with a non-`Error` that contains the phrase.** The TSDoc sends non-`Error` values to `String(error)` but matches "insufficient funds" on a "message", and wallets sometimes throw plain objects or strings. Tested reading: a bare string `'insufficient funds'` is a non-Error and passes through unchanged. Marker: `errors.test.ts`.
4. **Token address with a bad EIP-55 checksum.** `validateInvoiceForm` says `token` must be "a valid address". viem's `isAddress` is strict by default and rejects a mixed-case address with a wrong checksum; all-lowercase is accepted. Tested reading: bad checksum is invalid, lowercase valid. Marker: `lib.test.ts`.

## Tests that pass against the stubs (the red check)

`corepack pnpm test` against the stubs fails every test except these:

- `src/config.test.ts` (all 10 tests): `config.ts` is written in full at the interface tag, so these test real data: Sepolia chain, one injected connector, the PYUSD/USDC/USDG addresses from spec §5.1, `DEFAULT_TOKEN`, `EXPLORER_URL`, `ETH_FAUCET_URL`, no Tempo/MPP exports, and the env-driven `RPC_URL`, `FACTORY_ADDRESS`, `FACTORY_DEPLOY_BLOCK`.
- `src/lib/constants.test.ts` (5 tests): pure data constants written in full at the tag (`LOG_PAGE_SIZE`, `MAX_TIERS`, `REF_MAX_BYTES`, `BPS_DENOMINATOR`, `Status` / `STATUS_LABEL`). They guard against the implementer changing a frozen value.

The tests were also run against a throwaway reference implementation (not committed) to check that the fixtures, the fake JSON-RPC node in `fetch.test.ts` and the expectations are consistent and satisfiable.

Not covered: `readInvoice` and `readActiveDiscount` (`lib/invoice.ts`), which only wrap wagmi contract reads and have no logic to test without mocking wagmi internals.

## Mesh (node U1, Pay with Mesh)

5. **`payWithMesh` when the amount due now is zero.** Mesh spec §5 says "the clone's balance is below the amount due now"; the `visibleActions` TSDoc says `cloneBalance < dueNow`. With a 100% discount tier active (`dueNow = 0`) nothing can be below it, so the flag is false even with an empty clone, and the viewer gets Finish settlement only once something arrives. Tested reading: the literal `<` (false). Marker: `actions.test.ts`.
6. **"Unset" for `VITE_MESH_SERVER_URL`.** The existing env tests use `vi.stubEnv(name, '')`, not a deleted variable. `config.ts` uses `|| undefined`, so empty and unset should be the same. Tested reading: the empty-string stub stands for unset. Marker: `config.test.ts`.

### Mesh tests that pass against the stubs (the red check)

- `src/config.test.ts`, the two new tests (`MESH_TOKENS` subset/PYUSD+USDG/no USDC, and `MESH_SERVER_URL` unset or set): `config.ts` already holds the real data at the interface tag, as for the other config tests above. Config now has 12 tests, all passing.
- Every new or changed `actions.test.ts` test (45) and `meshSession.test.ts` test (6) fails against the stubs.

## Native ETH (U1)

7. **`isNative` with a zero address that is not 42 characters or has a `0X` prefix.** The TSDoc says "compared case-insensitively" and "any other string, including a non-address, is false". Tested reading: `0X000...0` and an upper-cased body are true (case-insensitive compare to `NATIVE_TOKEN`); a 43-character all-zero string, `'0x'`, `'0x0'`, `''` and `'ETH'` are false.
8. **`fundPath` token casing.** The TSDoc defers to `isNative(token)`, so any casing of the zero address, including the `0X` prefix, is `'native'`. Tested reading: yes.
9. **`visibleActions.withdraw` and `owed` with no account.** `owed` is documented as 0n with no account, but the rule says "connected and `owed > 0n`". Tested reading: with no account `withdraw` is false even if `owed > 0n`.
10. **`withdraw` on a Paid/Cancelled invoice.** Every other flag is false there, so the only flag that can be true is `withdraw`. Tested reading: `{ all false, withdraw: true }` for seller, buyer and stranger when `owed > 0n`.
11. **`buildHistory` for `Received`.** `invoiceRef` is dropped from the `inbound` entry. Tested reading: the entry has exactly the keys `timestamp`, `tx`, `from`, `amount`. `Transfer` and `Received` share one `inbound` list, sorted together by timestamp with stable ties.
12. **How "no `Transfer` query" is detected for an ETH invoice.** The TSDoc says no `Transfer` logs are read. The test treats any `eth_getLogs` call whose topic filter contains the ERC-20 `Transfer` topic0 as a Transfer query; it does not constrain the address filter. For an ETH invoice, ERC-20 `Transfer` logs in the fake node are also expected not to appear in `inbound`.
13. **`fetchInvoiceHistory` lifecycle query for ETH.** The TSDoc says escrow `Received`, `PayoutDeferred` and `Withdrawn` are read "from the escrow" in the same paged query as the other lifecycle events. The tests only check the resulting history and that events from other contracts are ignored, not the number of `eth_getLogs` calls.
14. **`Withdrawn` has no `invoiceRef`.** The decoded fixture log carries `account`, `to`, `amount` only (spec §3.9); history entries carry the same three.
15. **Config order.** The tests check `TOKENS` by symbol (not order) and the length 4; `DEFAULT_TOKEN` is `TOKENS[0]` with symbol PYUSD (as before). `MESH_TOKENS` is checked as a set of symbols.

### Native ETH tests that pass against the stubs (the red check)

- `tokens.test.ts` "NATIVE_TOKEN is the zero address and NATIVE_DECIMALS is 18": pure constants, written in full at the tag.
- `config.test.ts` "lists PYUSD, USDC and USDG ... and ETH" and "offers Pay with Mesh for PYUSD, USDG and ETH": `config.ts` already holds the real data at the tag.
- Every other new or changed test (28 new, plus the updated existing `fundPath`, `history` and `actions` tests) fails against the stubs.
