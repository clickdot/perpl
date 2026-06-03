# perpl-market-maker-ts-expt

**Pure WebSocket ("one-click trading" style) experimental market maker for Perpl perps on Monad mainnet.**

This is the WS-only experiment clone. It places and cancels orders exclusively through the authenticated trading WebSocket (`mt:22` OrderRequest for opens, `t=5` for cancels) — the same path the Perpl UI uses after you enable "one click trading". No per-order `execOrders` gas transactions from your EOA.

- Latest traded price (`lst` from the public unauthenticated market-data WS `market-state@143`) is used as the quoting center.
- Pure last-price × spread quoting (no BBO, no minOffset, no extra dynamic buffers). Only your configured spread (+ tiny tick rounding + optional inventory skew) creates the bid/ask difference.
- Full requested size on **both** sides every cycle, **except** when `--max-pos` would increase your exposure. In that case only the reducing (de-risk) side is quoted.
- Robust WS handling: auto-reconnect with exponential backoff, safe sends, heartbeat sequence tracking, separate hb sn for market data vs trading WS.

See the sibling directories in the workspace for the other variants:
- `perpl-market-maker-ts` — stable hybrid (WS for snapshots + on-chain `execOrders` for placement/cancels). More "set and forget" visible orders.
- `perpl-direct-onchain-mm` — pure on-chain every cycle (no trading WS for orders at all).

## Requirements

- Node >= 20
- A mainnet Monad wallet with:
  - Funds for gas (tiny amount of MON)
  - Deposited collateral on Perpl + an on-chain Exchange account (`createAccount` called on `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`)
  - (Recommended) "One click trading" / forwarding enabled in the Perpl UI for the account so WS-placed orders are visible and forwarded on-chain (`fw=true` in WalletSnapshot)
- `PRIVATE_KEY` (0x...) in `.env` (copy `.env.example`)

**This runs on mainnet with real money.** Start with tiny size.

## Quick start

```bash
cd perpl-market-maker-ts-expt
npm install

# Copy and edit .env (put your real mainnet key — never commit it)
cp .env.example .env
# edit .env

# Dry run first (recommended)
npm run dev -- --help

# LIVE run (your typical command)
LIVE=true npm run dev -- --perp 1 --size 0.0002 --spread 0.03 --leverage 10 --max-pos 0.0002 --interval 5
```

Common flags (see `--help` for all):

- `--perp 1` (or btc, 10/mon, etc.)
- `--size 0.0002`
- `--spread 0.03` (0.03%)
- `--leverage 10`
- `--max-pos 0.0002`
- `--interval 5`
- `--strategy bbo` (currently the "last price centered" strategy; "spread" is the ladder)

Set `LIVE=true` (env) to actually send orders. Without it everything is dry-run.

## How quoting works (current expt)

- Center = latest traded (`lst` preferred from market-data WS, fallback to on-chain lastPNS).
- `halfSpread = last * (spreadPct / 100 / 2)`
- Skew applied only to price for inventory management.
- `bid = last - halfSpread * (1 + skew*0.5)`, `ask = last + halfSpread * (1 - skew*0.5)`
- Round to the market's `priceDec` grid (floor for bids, ceil for asks).
- Size gates from `--max-pos`:
  - If long >= maxPos → no more bids.
  - If short >= maxPos → no more asks.
  - The opposite (reducing) side is still quoted so you can get out.
- Post-only (`fl=1`), 10x example, etc.

Orders are sent one-by-one with small delays, pre-canceled from the current WS snapshot every cycle.

## WS behavior & limitations

- Requires a successful SIWE auth + `AuthSignIn` (mt:4) + `WalletSnapshot` (mt:19) with `accId` and `lfr`.
- Orders only become visible in the UI / on-chain when the account has forwarding enabled.
- The trading WS is somewhat flaky (sees 1005/1006/1008 "too many connections"/1011 etc.). The client now has:
  - Proper connect timeouts + reject paths.
  - Guarded sends (`safeSend` + readyState checks).
  - Single backoff timer for reconnects (exponential).
  - Heartbeat sequence gap detection (with debounce) that forces resync reconnects only on real gaps.
  - Separate tracking for hb sequence numbers.
- On disconnect the maker gracefully skips placement/cancel that cycle and retries via `ensureConnected`.
- Graceful SIGINT shutdown attempts to cancel known opens via WS.

If you see repeated "too many connections", only run one instance and make sure the Perpl UI isn't also holding an active trading session for the same account.

## Project layout

```
src/
  index.ts          # CLI (yargs) + banner + start
  config.ts         # mainnet defaults + .env loading
  marketMaker.ts    # core loop, quoting (calculateQuotes), cycle, place/cancel
  tradingWs.ts      # authenticated trading WS client (auth, connect, place mt:22, cancel t=5, snapshots, reconnect)
  marketDataWs.ts   # public WS for lst / market-state
  client.ts         # viem reads (position, perpetual info, etc.) + helpers
  abi.ts            # Exchange contract bits + OrderDesc etc.
```

`npm run dev` uses `tsx` (no build step required for development).

## .env

Never commit your real `.env`. The provided `.env.example` has safe defaults + comments.

Required: `PRIVATE_KEY=0x...`

## License

MIT (same as siblings).

---

This expt is for exploring the WS path. The hybrid version in the sibling directory is generally more reliable for always-visible orders.

Run at your own risk on mainnet.
