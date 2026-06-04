#!/usr/bin/env node
/**
 * Perpl Mainnet Market Maker (standalone)
 *
 * Usage:
 *   tsx src/index.ts --perp btc --size 0.001 --spread 0.1 --leverage 2
 *   LIVE=true tsx src/index.ts --perp 1 --size 0.001 --strategy spread --orders 3
 */
import { parseArgs } from "node:util";
import { loadConfig, resolvePerpId } from "./config.js";
import { PerplClient } from "./client.js";
import { PerplMarketMaker, type MMConfig } from "./marketMaker.js";

const env = loadConfig();

const { values } = parseArgs({
  options: {
    perp: { type: "string", short: "p", default: env.defaultPerpId },
    size: { type: "string", short: "s", default: String(env.defaultSizeUsd) },
    spread: { type: "string", default: String(env.defaultSpreadBps) },
    leverage: { type: "string", short: "l", default: String(env.defaultLeverage) },
    "max-pos": { type: "string", default: String(env.defaultMaxPosUsd) },
    interval: { type: "string", short: "i", default: String(env.defaultIntervalSec) },
    strategy: { type: "string", default: "bbo" }, // bbo | spread
    orders: { type: "string", short: "n", default: "2" },
    "spread-step": { type: "string", default: "0.2" },
    "post-only": { type: "boolean", default: true },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`
Perpl Mainnet Market Maker

Options:
  --perp, -p        Market (1/btc, 10/mon, 20/eth, 30/sol or raw id)   [default: 1]
  --size, -s        Order size in USD per side                         [default: from env]
  --spread          Distance from mark in bps (bbo = half-spread)      [default: from env]
  --leverage, -l    Leverage (e.g. 2)                                  [default: from env]
  --max-pos         Max abs position (USD) used for price skew calc    [default: from env]
  --interval, -i    Re-quote interval seconds                          [default: from env]
  --strategy        bbo | spread                                       [default: bbo]
                          bbo: symmetric around latest traded price using --spread (always both sides)
  --orders, -n      Orders per side (spread only)                      [default: 2]
  --spread-step     % step between ladder levels (spread)              [default: 0.2]
  --post-only       Use post-only orders (default true)
  --dry-run         Force simulation (no txs) — default unless LIVE=true
  --help, -h        This help

Examples:
  tsx src/index.ts --perp btc --size 0.001 --spread 0.1
  LIVE=true tsx src/index.ts --perp 1 --size 0.0005 --strategy spread -n 3 --spread-step 0.15 -l 1
`);
  process.exit(0);
}

async function main() {
  const perpId = resolvePerpId(values.perp as string);
  const size = parseFloat(values.size as string);
  const spreadBps = parseFloat(values.spread as string);
  const leverage = parseFloat(values.leverage as string);
  const maxPos = parseFloat(values["max-pos"] as string);
  const intervalSec = parseInt(values.interval as string, 10);
  const strategy = (values.strategy as string).toLowerCase() as "bbo" | "spread";
  const ordersPerSide = parseInt(values.orders as string, 10);
  const spreadStep = parseFloat(values["spread-step"] as string);
  const postOnly = values["post-only"] !== false;
  const forceDry = values["dry-run"] as boolean;

  const live = env.live && !forceDry;

  console.log("════════════════════════════════════════════════════════════");
  console.log("  PERPL MAINNET MARKET MAKER");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Exchange:     ${env.exchangeAddress}`);
  console.log(`  Wallet:       ${env.privateKey.slice(0, 6)}...${env.privateKey.slice(-4)}`);
  console.log(`  Perp:         ${perpId}`);
  console.log(`  Strategy:     ${strategy.toUpperCase()}`);
  console.log(`  Size/side:    $${size}`);
  console.log(`  Spread:       ${spreadBps} bps`);
  if (strategy === "spread") {
    console.log(`  Orders/side:  ${ordersPerSide}`);
    console.log(`  Step:         ${spreadStep}%`);
  }
  console.log(`  Leverage:     ${leverage}x`);
  console.log(`  Max Pos:      $${maxPos}`);
  console.log(`  Interval:     ${intervalSec}s`);
  console.log(`  Post-only:    ${postOnly}`);
  console.log(`  Mode:         ${live ? "LIVE" : "DRY-RUN"}`);
  console.log("════════════════════════════════════════════════════════════\n");

  const client = new PerplClient(env);

  const mmConfig: MMConfig = {
    perpId,
    orderSizeUsd: size,
    spreadBps,
    leverage,
    maxPositionUsd: maxPos,
    intervalMs: intervalSec * 1000,
    strategy,
    postOnly,
    ordersPerSide: strategy === "spread" ? ordersPerSide : undefined,
    spreadStepPct: strategy === "spread" ? spreadStep : undefined,
  };

  const mm = new PerplMarketMaker(client, mmConfig, live, env as any);
  await mm.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
