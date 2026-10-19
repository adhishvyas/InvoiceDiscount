# Re-entrancy: The Bug That Split Ethereum in Two

> Written October 2026. A blog-style explainer on re-entrancy, why the *order* of lines inside a contract function matters so much, and how the industry defends against it today. The examples are Solidity on the EVM, which covers Tempo too. At the end we look at how this project's `InvoiceEscrow` contract applies the same defences.

## TL;DR

- When a smart contract calls another contract (including when it sends ETH), it **hands over control** to code it does not own. That code can **call back into the original contract before the first call has finished**. That callback is *re-entrancy*.
- If the original contract has **not yet updated its own state** when it hands over control, the callback sees stale state: "this user still has a balance," "this invoice is still unpaid." The attacker repeats the action again and again in one transaction.
- In June 2016 this drained about **3.6 million ETH from The DAO** and led to the hard fork that split Ethereum (ETH) from Ethereum Classic (ETC).
- The fixes, roughly in order of importance:
  1. **Checks-Effects-Interactions (CEI):** validate, then write your state, and only *then* call out.
  2. **Re-entrancy guards (mutexes):** a lock that makes a second entry revert. Now cheap thanks to transient storage (EIP-1153).
  3. **Pull over push:** let users withdraw their own money instead of the contract sending it to them in the middle of other logic.
  4. **Tooling and newer platforms:** static analysers flag the pattern, and some newer chains block re-entrancy at the VM level.

---

## 1. A bank that runs its lines in the wrong order

Imagine a bank teller who handles a withdrawal like this:

1. Check your account: "you have $100."
2. Hand you $100 in cash.
3. Write "$0" in the ledger.

Now imagine you could freeze time between steps 2 and 3, walk back to the counter, and ask again. The ledger still says $100, so the teller pays you again, and again, and again. Only when you finally stop does the teller get round to writing "$0", once for each visit.

In the real world you can't freeze time between steps 2 and 3. **On the EVM, you can.** That is the whole bug.

### Why the EVM lets you "freeze time"

On Ethereum, sending ETH to an address is a **call**. If the recipient is a contract, the EVM runs that contract's `receive()` (or `fallback()`) function. That code runs **in the middle of** the sender's function, and it can do anything, including calling the sender again.

The same is true of any external call: calling a token, an oracle, a callback hook, or a contract supplied by the user. The calling function is paused on that line until the callee returns. During the pause, the caller's storage is exactly as it was at the moment of the call.

Developers in 2015–2016 mostly thought of "send money" as an action at the end of a function, like a `return`. It isn't. It is a jump into someone else's code.

---

## 2. The concrete example: a vulnerable vault

Here is a minimal ETH vault. Users deposit ETH and can withdraw their balance later.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VulnerableVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");

        // ❌ INTERACTION before EFFECT: we send the money first...
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");

        // ...and only then record that it has been withdrawn.
        balances[msg.sender] = 0;
    }
}
```

It reads naturally: look up the balance, pay it out, zero it. It compiles cleanly, and every normal test passes. Honest users deposit and withdraw without trouble.

### The attacker

```solidity
contract Attacker {
    VulnerableVault public immutable vault;

    constructor(VulnerableVault _vault) {
        vault = _vault;
    }

    function attack() external payable {
        require(msg.value == 1 ether);
        vault.deposit{value: 1 ether}();
        vault.withdraw();                    // start the loop
    }

    // Runs every time the vault sends us ETH.
    receive() external payable {
        if (address(vault).balance >= 1 ether) {
            vault.withdraw();                // re-enter before balances[this] is zeroed
        }
    }
}
```

### Step-by-step trace

Say honest users have deposited **10 ETH**. The attacker deposits **1 ETH**, so the vault holds 11 ETH and `balances[attacker] == 1 ETH`.

| Step | Call depth | What happens | `balances[attacker]` | Vault ETH |
|---|---|---|---|---|
| 1 | 1 | `withdraw()` reads `amount = 1 ETH`; check passes | 1 | 11 |
| 2 | 1 | Vault sends 1 ETH → **Attacker.receive() runs** | 1 | 10 |
| 3 | 2 | `receive()` calls `withdraw()` again. It reads `amount = 1 ETH` (**still not zeroed!**) | 1 | 10 |
| 4 | 2 | Vault sends 1 ETH → `receive()` runs again | 1 | 9 |
| … | … | …repeats… | 1 | … |
| 13 | 11 | Vault balance is 0, so `receive()` stops recursing and returns | 1 | 0 |
| 14 | 11 → 1 | Each paused `withdraw()` resumes and runs `balances[attacker] = 0`, eleven times | 0 | 0 |

The attacker put in 1 ETH and took out 11. **Every individual line did what it said.** The bug is only in the **order** of the lines: the state that the check relies on was updated *after* control left the contract.

> **A Solidity 0.8 subtlety.** Solidity 0.8 added checked arithmetic. If the last line had been `balances[msg.sender] -= amount;`, the second frame to unwind would compute `0 - 1 ETH`, revert, and that revert would bubble up through `require(ok)` and undo the whole attack. That is luck, not design: the `= 0` form (which is what The DAO effectively did) is perfectly legal and fully exploitable, as is any version where the stale value is not a balance at all (a status flag, a "claimed" bit). Do not rely on overflow checks to protect you from re-entrancy.

---

## 3. The DAO, June 2016

**The DAO** was a crowd-funded investment fund that ran as a contract on Ethereum. It raised about 12.7 million ETH, around 14% of all ETH in existence at the time.

It let members leave by "splitting" into a child DAO and taking their share of ETH with them. The `splitDAO` function **sent the ETH first and updated the member's token balance afterwards**, exactly the pattern above. On **17 June 2016** an attacker used a recursive split to drain about **3.6 million ETH** (roughly $50–60 million at the time) into a child DAO.

The funds were stuck in the child DAO for 28 days because of its own rules, which gave the community time to argue. In **July 2016** Ethereum hard-forked to move the funds back to a refund contract. A part of the community rejected the fork on "code is law" grounds and kept running the original chain, which is **Ethereum Classic** today.

One misordered pair of lines produced a permanent split of the second-largest blockchain.

---

## 4. It didn't stop in 2016: the variants

Re-entrancy is a *family* of bugs, and each new variant caught teams who thought they had already fixed the original.

### 4.1 Single-function re-entrancy

The vault above: the attacker re-enters the **same** function.

### 4.2 Cross-function re-entrancy

The attacker re-enters a **different** function that shares the same state.

```solidity
function transfer(address to, uint256 amount) external {
    require(balances[msg.sender] >= amount);
    balances[msg.sender] -= amount;
    balances[to] += amount;
}
```

Add this to the vulnerable vault. Now, during the external call in `withdraw()`, the attacker's `receive()` calls `transfer()` and moves the not-yet-zeroed balance to a second account it controls. `withdraw()` then zeroes the first account. The attacker has been paid **and** kept the balance. A lock on `withdraw()` alone would not stop this. Every function that touches the shared state needs protecting.

### 4.3 Cross-contract re-entrancy

The same idea across **several contracts** in one protocol, for example a lending pool and a separate rewards contract that both read the same accounting. A per-contract lock does nothing if the attacker re-enters through the sibling contract.

### 4.4 Re-entrancy through token hooks

Plain ERC-20 transfers don't run recipient code, so developers assumed token transfers were "safe" external calls. Then token standards with **hooks** appeared:

- **ERC-777** calls `tokensReceived` / `tokensToSend` on the parties to a transfer. In **April 2020**, imBTC (an ERC-777 token) was used to re-enter **Uniswap v1** pools and the **Lendf.Me** lending protocol (about $25 million lost at Lendf.Me).
- **ERC-721 / ERC-1155** `safeTransferFrom` calls `onERC721Received` / `onERC1155Received` on the recipient. Many NFT mints have been re-entered through this hook to mint past a per-wallet limit.
- In **August 2021**, **Cream Finance** lost about $18.8 million through the AMP token, which also had transfer hooks.

The lesson: **any call to an address you did not write is an interaction**, even if it "just moves tokens."

### 4.5 Read-only re-entrancy

The newest and sneakiest variant. The attacker re-enters a **view function** while the target contract is halfway through an update, and a **third-party** protocol reads that inconsistent value, for example a pool's price or LP-token value, and acts on it.

The vulnerable contract does not lose any money itself, and its own state-changing functions may be properly locked. The *victim* is whoever trusted its `view` function mid-call. Several lending protocols that priced collateral using Curve pool LP values were hit this way in 2022–2023.

### 4.6 When the guard itself is broken

On **30 July 2023**, several Curve pools were drained (around $60–70 million in total) even though they **did** use re-entrancy locks. The pools were written in Vyper, and certain Vyper compiler versions (0.2.15, 0.2.16 and 0.3.0) had a bug that gave each function its own storage slot for the lock instead of sharing one. The `@nonreentrant` decorator looked correct in the source but did not protect anything in the bytecode.

Defence in depth matters: a lock is good, but a lock **plus** correct ordering survives a broken lock.

---

## 5. How it's resolved today

### 5.1 Checks-Effects-Interactions (CEI): fix the order

This is the fundamental fix, and it costs nothing. Every state-changing function is written in three strictly ordered phases:

1. **Checks:** validate inputs, permissions and state (`require`, custom errors).
2. **Effects:** write **all** of your own state changes.
3. **Interactions:** only now call external contracts or send value.

Here is the vault, fixed:

```solidity
function withdraw() external {
    // 1. Checks
    uint256 amount = balances[msg.sender];
    require(amount > 0, "nothing to withdraw");

    // 2. Effects
    balances[msg.sender] = 0;

    // 3. Interactions
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok, "send failed");
}
```

Re-run the attack: the first `withdraw()` zeroes the balance *before* sending. When `receive()` re-enters, `amount` is `0`, the check fails, and the inner call reverts. That revert makes `ok == false`, and the outer `require` reverts the whole transaction. The attacker gets nothing and pays gas.

Note that the "send failed" path is safe *because* of the ordering. If the send fails, the whole function reverts, which also rolls back the effect.

CEI also fixes the cross-function variant: when the attacker's callback runs, every function sees the already-updated state.

### 5.2 Re-entrancy guards: lock the door

A guard is a mutex stored in the contract. Entering a guarded function sets the lock, and a second entry while it is set reverts.

```solidity
// The classic pattern (OpenZeppelin's ReentrancyGuard, simplified).
uint256 private _locked = 1;

modifier nonReentrant() {
    require(_locked == 1, "reentrant call");
    _locked = 2;
    _;
    _locked = 1;
}

function withdraw() external nonReentrant { /* ... */ }
function transfer(address to, uint256 amount) external nonReentrant { /* ... */ }
```

Because the lock is **one shared slot**, putting `nonReentrant` on every state-changing function also blocks cross-function re-entrancy within the contract. (The bug in §4.6 was precisely that the "shared" slot wasn't shared.)

**The cost problem, and how it was solved.** A storage-based lock costs thousands of gas per call: writing a slot, then resetting it. That pushed many teams to skip it. In **March 2024** Ethereum's Dencun upgrade shipped **EIP-1153 transient storage** (`TSTORE`/`TLOAD`): storage that is automatically wiped at the end of each transaction and costs about 100 gas per access. A lock is the perfect use for it:

```solidity
// Solidity >= 0.8.24, an EVM with transient storage (Cancun or later; Tempo targets Osaka).
modifier nonReentrant() {
    assembly {
        if tload(0) { revert(0, 0) }
        tstore(0, 1)
    }
    _;
    assembly { tstore(0, 0) }
}
```

OpenZeppelin ships this as `ReentrancyGuardTransient`. Solidity also supports `transient` as a storage location keyword for value types (`bool transient locked;`).

**Guarding views (read-only re-entrancy).** A lock on state-changing functions does not stop a `view` from returning half-updated values. Protocols that expose prices or share values should make those views **revert while the lock is held** (OpenZeppelin exposes `_reentrancyGuardEntered()` for this), and protocols that *consume* other protocols' views should check for that.

### 5.3 Pull over push

Instead of sending money to people in the middle of business logic, **record what they are owed and let them withdraw it themselves** in a separate, tiny, CEI-ordered function.

```solidity
mapping(address => uint256) public owed;

function settle(address winner, uint256 prize) internal {
    owed[winner] += prize;          // effect only, no external call here
}

function claim() external {
    uint256 amount = owed[msg.sender];
    owed[msg.sender] = 0;           // effect
    (bool ok, ) = msg.sender.call{value: amount}("");  // interaction
    require(ok);
}
```

This shrinks the "dangerous" surface to one small function that is easy to audit. As a bonus, it stops one recipient whose `receive()` reverts from blocking payouts to everyone else (a denial-of-service bug that push-style loops suffer from).

### 5.4 A fix that aged badly: `transfer()` and `send()`

After The DAO, the common advice was to send ETH with `address.transfer(amount)` or `send()`, which forward only a **2,300 gas stipend**. That is too little gas for the recipient to call back into anything, so re-entrancy seemed impossible.

That advice is now **discouraged**. Gas costs are not fixed. EIP-1884 (Istanbul, 2019) raised the cost of some opcodes and broke contracts whose `receive()` had fitted in 2,300 gas, including many multisig and smart-contract wallets. Relying on a gas constant for security ties your safety to future repricing decisions. The modern guidance is: use `call`, and get your safety from CEI and guards, not from starving the callee of gas.

### 5.5 Tooling

- **Static analysers** like Slither flag state writes after external calls (`reentrancy-eth`, `reentrancy-no-eth` and related detectors). Run them in CI.
- **Fuzzing and invariant testing** (Foundry, Echidna, Medusa) with a malicious-receiver contract in the test harness catches many of these before an audit does.
- **Audits and formal verification** for anything holding real value.

### 5.6 Newer platforms close the door at the VM level

Some newer smart contract platforms make re-entrancy impossible or rare by design instead of leaving it to each developer:

- **Soroban (Stellar):** the host rejects a contract re-entering itself through a cross-contract call, so the classic loop can't be expressed. (Relevant to this project's [`stellar/`](../../../stellar/) implementation.)
- **Solana:** cross-program invocations allow a program to call itself directly, but block indirect re-entrancy (A → B → A).
- **Move (Aptos, Sui):** the resource and module model makes the "pay first, update later" shape hard to write, and dynamic dispatch back into a caller is restricted.

The EVM, including Tempo, keeps the original semantics for compatibility, so on EVM chains the discipline is still on the developer.

---

## 6. A note on the other kind of "ordering"

People sometimes use "ordering" in smart contracts to mean something else: **transaction ordering**, also called front-running or MEV. That is about the order of *whole transactions in a block* (for example, someone sees your trade in the mempool and puts theirs first), not the order of *lines inside a function*. It is a real and separate problem, with separate fixes (slippage limits, commit-reveal, private mempools, batch auctions). Re-entrancy is entirely about the order of lines within one transaction, and the fix is under your control as the contract author.

---

## 7. How this project applies it

The Tempo `InvoiceEscrow` contract ([`contracts/src/InvoiceEscrow.sol`](../../contracts/src/InvoiceEscrow.sol)) moves stablecoins in three places: `fund()`, `triggerPayment()` and `cancel()`. Each one follows CEI explicitly, and the NatSpec of each function documents the "Checks / Effects / Interactions" order.

`triggerPayment()` is a good example:

```solidity
function triggerPayment() external {
    // Checks
    address buyer = _buyer;
    if (msg.sender != _seller && (buyer == address(0) || msg.sender != buyer)) revert NotParty();
    if (_status != Status.Funded) revert NotFunded();

    // ...compute amounts from current state...

    // Effects: the invoice is marked Paid BEFORE any tokens move
    _status = Status.Paid;

    // Interactions
    ITIP20 token = ITIP20(_token);
    bytes32 invoiceRef = _invoiceRef;
    token.transferWithMemo(payout, toSeller, invoiceRef);
    if (refundAmount > 0) token.transferWithMemo(refundTo, refundAmount, invoiceRef);

    emit Paid(msg.sender, payout, toSeller, refundTo, refundAmount, bps);
}
```

(Comments added here for clarity. The source documents the same order in its NatSpec.)

If anything during those transfers managed to call back into the invoice, `triggerPayment()` would revert with `NotFunded` and `cancel()` would revert with `AlreadySettled`, because `_status` already reads `Paid`. The same holds for `cancel()` (status set to `Cancelled` before the refund) and `fund()` (buyer and `Funded` status written before the `transferFromWithMemo` pull).

Two things make this more robust than the vault example:

1. **There is a single status field that every function checks.** One state machine (`Active → Funded → Paid | Cancelled`), written before any interaction, covers single-function and cross-function re-entrancy together.
2. **The token is a TIP-20 stablecoin**, Tempo's built-in token standard. Like plain ERC-20, it has no recipient hooks, so in normal operation a transfer does not run the recipient's code at all. CEI is defence in depth: the contract stays correct even if that assumption ever changed.

The contract does not use a `nonReentrant` modifier. With strict CEI, one status field, and no hook-bearing tokens, a lock would add gas without closing any remaining path. That is a deliberate trade-off, and worth revisiting if the contract ever accepts arbitrary tokens or adds calls to user-supplied contracts.

---

## Checklist

When you review a function that makes an external call, ask:

- [ ] Are **all** state writes done before the first external call (CEI)?
- [ ] Could the callee re-enter a **different** function that reads the same state?
- [ ] Is "just a token transfer" really hook-free for **every** token this contract can be given?
- [ ] Do any `view` functions return values that are inconsistent mid-call, and does anyone else rely on them?
- [ ] If there is a lock, is it **one shared slot** across all the functions that need it?
- [ ] Are we relying on a **gas stipend** or **overflow check** for safety? (Don't.)
- [ ] Does a malicious-receiver test exist in the test suite?

## Further reading

- Solidity docs, *Security Considerations → Re-entrancy* and *Use the Checks-Effects-Interactions Pattern*.
- OpenZeppelin Contracts: `ReentrancyGuard`, `ReentrancyGuardTransient`, `PullPayment` (historical).
- EIP-1153 (transient storage) and EIP-1884 (the repricing that broke the 2,300-gas assumption).
- Post-mortems: The DAO (2016), Lendf.Me / imBTC (2020), Cream Finance (2021), the Curve / Vyper compiler incident (2023).
