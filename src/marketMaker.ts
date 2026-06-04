/**
 * Mainnet Perpl Market Maker (expt)
 *
 * Strategy:
 *  - bbo   : quote symmetrically around the *latest traded price* (lst / lastPNS) using the user --spread.
 *            Always full size on BOTH sides every interval; no inventory suppression.
 *            Only the spread (plus optional skew + tick rounding) determines bid/ask diff.
 *  - spread: ladder (unchanged)
 *
 * Latest price from market-data WS (preferred) or on-chain lastPNS.
 *
 * This version is intentionally simple and polling-based so it has zero extra deps.
 * For production-grade event-driven version, consume the public market-data WS and/or
 * index OrderRequest events (see Rust dex-sdk-examples/market-making for reference impl).
 */
import { PerplClient, type PerpetualInfo, type PositionInfo } from "./client.js";
import { OrderType, type OrderDesc } from "./abi.js";
import type { PerplConfig } from "./config.js";
import { TradingWsClient } from "./tradingWs.js";
import { MarketDataWsClient } from "./marketDataWs.js";

export interface MMConfig {
  perpId: bigint;
  orderSizeUsd: number;
  spreadBps: number; // e.g. 1 for 1 bps (0.01%)
  leverage: number;
  maxPositionUsd: number;
  intervalMs: number;
  strategy: "bbo" | "spread";
  postOnly: boolean;
  ordersPerSide?: number; // for spread
  spreadStepPct?: number; // for spread
}

export interface MMState {
  markPrice: number;
  priceDecimals: number;
  lotDecimals: number;
  positionSize: number; // positive = long, negative = short, in human lots
  openOrderIds: bigint[]; // the ones we placed this cycle (best effort tracking)
}

export class PerplMarketMaker {
  private client: PerplClient;
  private cfg: MMConfig;
  private live: boolean;
  private running = false;
  private lastOrderIds = new Set<bigint>();
  private tradingWs?: TradingWsClient;
  private marketDataWs?: MarketDataWsClient;
  private fullConfig?: PerplConfig;

  constructor(client: PerplClient, mmConfig: MMConfig, live: boolean, fullConfig?: PerplConfig) {
    this.client = client;
    this.cfg = mmConfig;
    this.live = live;
    this.fullConfig = fullConfig;
  }

  private scaleLot(size: number, lotDecimals: number): bigint {
    const factor = 10 ** lotDecimals;
    return BigInt(Math.round(size * factor));
  }

  private scalePrice(price: number, priceDecimals: number): bigint {
    const factor = 10 ** priceDecimals;
    return BigInt(Math.round(price * factor));
  }

  private unscale(value: bigint, decimals: number): number {
    return Number(value) / 10 ** decimals;
  }

  private leverageToHdths(lev: number): bigint {
    // Perpl uses hundredths of a percent? No — leverageHdths = leverage * 100 (e.g. 2x = 200)
    // From PerplBot + dex examples: leverageHdths, 1x = 100, 2x=200 etc.
    return BigInt(Math.round(lev * 100));
  }

  async getMarkAndDecimals(perpId: bigint): Promise<{
    mark: number;
    priceDec: number;
    lotDec: number;
    info: PerpetualInfo;
  }> {
    const info = await this.client.getPerpetualInfo(perpId);
    const priceDecN = Number(info.priceDecimals);

    // Prefer live "latest price" (last traded) from market-data WS (see websocket.md mt:9 MarketStateUpdate .lst)
    // This is what the user requested instead of on-chain mark price (mrk).
    let ref: number;
    const wsLst = this.marketDataWs?.getLastPrice(Number(perpId));
    if (wsLst != null && wsLst > 0) {
      ref = wsLst / (10 ** priceDecN);
    } else {
      // Fallback to on-chain last price (lastPNS) if available, else mark.
      const pns = (info as any).lastPNS && (info as any).lastPNS > 0n ? (info as any).lastPNS : info.markPNS;
      ref = this.unscale(pns, priceDecN);
    }

    return {
      mark: ref,
      priceDec: priceDecN,
      lotDec: Number(info.lotDecimals),
      info,
    };
  }

  async getCurrentPosition(perpId: bigint, accountId: bigint, lotDec: number): Promise<{ size: number; side: "LONG" | "SHORT" | "NONE" }> {
    const pos = await this.client.getPosition(perpId, accountId);
    if (!pos || pos.lotLNS === 0n) return { size: 0, side: "NONE" };
    const size = this.unscale(pos.lotLNS, lotDec);
    const side = pos.positionType === 0 ? "LONG" : "SHORT";
    return { size: pos.positionType === 1 ? -size : size, side };
  }

  /**
   * Build desired quotes.
   * For BBO we use symmetric around latest/last price (lst from market-state WS or lastPNS).
   * For spread we build a small ladder.
   * Only the --spread (plus rounding to tick grid) determines the bid/ask price difference.
   */
  calculateQuotes(mark: number, currentPos: number, priceDec: number, lotDec: number): OrderDesc[] {
    const { orderSizeUsd, spreadBps, leverage, maxPositionUsd, strategy, postOnly, ordersPerSide = 2, spreadStepPct = 0.2 } = this.cfg;

    // Convert USD sizes to lots dynamically based on mark price
    const orderSizeLots = mark > 0 ? orderSizeUsd / mark : 0;
    const maxPositionLots = mark > 0 ? maxPositionUsd / mark : 0;
    const spreadPct = spreadBps / 100;

    const halfSpread = mark * (spreadPct / 100 / 2);
    const levHdths = this.leverageToHdths(leverage);

    const quotes: OrderDesc[] = [];

    // Inventory skew: if long, make bids worse (or stop buying), tighten asks
    const skew = Math.max(-0.8, Math.min(0.8, currentPos / maxPositionLots));

    if (strategy === "bbo") {
      // Quote symmetrically around the latest traded price using the user-specified spread.
      // No BBO approximation, no extra buffer/offset/min — only the spread (plus skew for inventory + tick rounding) causes the price difference.
      // Always full size on both sides; requote every interval.
      let bidPrice = mark - halfSpread * (1 + skew * 0.5);
      let askPrice = mark + halfSpread * (1 - skew * 0.5);

      bidPrice = Math.floor(bidPrice * 10 ** priceDec) / 10 ** priceDec;
      askPrice = Math.ceil(askPrice * 10 ** priceDec) / 10 ** priceDec;

      // No extra force — only spread/rounding should determine the difference.
      // (For spreads << tick size, effective diff will be governed by the price grid.)

      // Respect max-pos for sizes: only post the side that would not increase exposure beyond max.
      // We check if filling the order would push us past the max position (using a tiny epsilon for float fuzz).
      const eps = 1e-6;
      const bidSize = currentPos + orderSizeLots <= maxPositionLots + eps ? orderSizeLots : 0;
      const askSize = currentPos - orderSizeLots >= -maxPositionLots - eps ? orderSizeLots : 0;

      // Push ask/short first then bid/long; order may affect which get assigned in batch result for some contract states.
      // Always use Open* (never Close*) so that we post resting orders on *both* sides of the book even when we have an open position.
      // The exchange will automatically net fills against existing position; using Close* can result in only one side getting an orderId.
      if (askSize > 0) {
        quotes.push(
          this.client.makeOpenDesc({
            perpId: this.cfg.perpId,
            side: "short",
            pricePNS: this.scalePrice(askPrice, priceDec),
            lotLNS: this.scaleLot(askSize, lotDec),
            leverageHdths: levHdths,
            postOnly,
          })
        );
      }
      if (bidSize > 0) {
        quotes.push(
          this.client.makeOpenDesc({
            perpId: this.cfg.perpId,
            side: "long",
            pricePNS: this.scalePrice(bidPrice, priceDec),
            lotLNS: this.scaleLot(bidSize, lotDec),
            leverageHdths: levHdths,
            postOnly,
          })
        );
      }
    } else {
      // Spread ladder around mark
      for (let i = 1; i <= ordersPerSide; i++) {
        const offset = (spreadStepPct / 100) * i;
        const bidP = mark * (1 - offset);
        const askP = mark * (1 + offset);

        // Respect max-pos for sizes: only post the side that would not increase exposure beyond max.
        const eps = 1e-6;
        const bidSz = currentPos + orderSizeLots <= maxPositionLots + eps ? orderSizeLots : 0;
        const askSz = currentPos - orderSizeLots >= -maxPositionLots - eps ? orderSizeLots : 0;

        // ask first then bid for consistency with bbo
        if (askSz > 0) {
          quotes.push(
            this.client.makeOpenDesc({
              perpId: this.cfg.perpId,
              side: "short",
              pricePNS: this.scalePrice(askP, priceDec),
              lotLNS: this.scaleLot(askSz, lotDec),
              leverageHdths: levHdths,
              postOnly,
            })
          );
        }
        if (bidSz > 0) {
          quotes.push(
            this.client.makeOpenDesc({
              perpId: this.cfg.perpId,
              side: "long",
              pricePNS: this.scalePrice(bidP, priceDec),
              lotLNS: this.scaleLot(bidSz, lotDec),
              leverageHdths: levHdths,
              postOnly,
            })
          );
        }
      }
    }

    return quotes;
  }

  async cancelKnownOrders(): Promise<void> {
    if (!this.live) {
      this.lastOrderIds.clear();
      return;
    }

    // Pure WS mode: cancel whatever is currently open per the trading WS snapshot.
    // WS sends (mt:22 t=5) to let the session/backend handle cancel (no onchain tx/gas from us).
    // Snapshot is authoritative for current opens.
    if (this.tradingWs) {
      await this.tradingWs.ensureConnected().catch(() => {});
    }
    if (this.tradingWs && this.tradingWs.connected && this.tradingWs.accId > 0) {
      let opens: any[] = [];
      const perpNum = Number(this.cfg.perpId);
      const byp = (this.tradingWs as any).openOrdersByPerp as Map<number, Map<number, any>> | undefined;
      if (byp && byp.has(perpNum)) {
        opens = Array.from(byp.get(perpNum)!.values());
      } else if (this.tradingWs.openOrders && this.tradingWs.openOrders.size > 0) {
        for (const [oidn, o] of this.tradingWs.openOrders.entries()) {
          const om = Number((o as any).mkt ?? (o as any).market ?? (o as any).perp ?? (o as any).perpId ?? perpNum);
          if (om === perpNum) opens.push(o);
        }
        if (opens.length === 0) {
          opens = Array.from(this.tradingWs.openOrders.values());
        }
      }
      if (opens.length > 0) {
        console.log(`  [WS] ${opens.length} open from snapshot`);
      }
      const wsOids: number[] = [];
      for (const o of opens) {
        const oid = Number((o as any).oid ?? (o as any).scid ?? (o as any).id ?? (o as any).orderId ?? 0);
        if (oid > 0) wsOids.push(oid);
      }
      for (const wid of wsOids) {
        try {
          await this.tradingWs.cancelOrder(perpNum, this.tradingWs.accId, wid);
        } catch (e: any) {
          console.log(`  WS cancel for ${wid} warning: ${e.message || e}`);
        }
      }
      if (wsOids.length > 0) {
        console.log(`  sent ${wsOids.length} WS cancel request(s) (session oid(s): ${wsOids.join(",")})`);
      }
    }

    this.lastOrderIds.clear();
  }

  async placeQuotes(quotes: OrderDesc[]): Promise<void> {
    if (quotes.length === 0) {
      console.log("  no quotes to place (inventory limits reached?)");
      return;
    }
    if (!this.live) {
      for (const q of quotes) {
        const side = q.orderType === OrderType.OpenLong ? "BID" : "ASK";
        const priceRaw = q.pricePNS.toString();
        const lotRaw = q.lotLNS.toString();
        console.log(`    [DRY] ${side} lotLNS=${lotRaw} @ pricePNS=${priceRaw} (postOnly=${q.postOnly})`);
      }
      return;
    }

    if (this.tradingWs) {
      await this.tradingWs.ensureConnected().catch(() => {});
    }
    if (!this.tradingWs || !this.tradingWs.connected || !this.tradingWs.accId) {
      console.log("Trading WS not authed/connected, skipping placement this cycle");
      return;
    }

    // Pure WS placement for this expt clone (mt:22 OrderRequest via authenticated trading WS, matching UI one-click).
    // No onchain exec for placement (avoids EOA gas).
    // tradingWs used for snapshots (current opens for cancel) + auth/heartbeats/reconnects + placement + WS cancels.
    // Cancel current opens (from snapshot) before place → always re-quote both sides.
    // Oids come from WS snapshots.
    const rqs: number[] = [];
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      const side = q.orderType === OrderType.OpenLong ? "long" : "short";
      const price = Number(q.pricePNS);
      const size = Number(q.lotLNS);
      const lv = Number(q.leverageHdths);
      const postOnly = q.postOnly;
      try {
        const res = await this.tradingWs.placeOrder({
          marketId: Number(this.cfg.perpId),
          accountId: this.tradingWs.accId,
          side,
          size,
          price,
          leverageHdths: lv,
          postOnly,
        });
        console.log(`  placed ${side} via WS rq=${res.rq}`);
        rqs.push(res.rq);
        if (i < quotes.length - 1 && this.live) {
          await new Promise(r => setTimeout(r, 250));
        }
      } catch (e: any) {
        console.error(`  place ${side} via WS failed: ${e.shortMessage || e.message}`);
      }
    }
    console.log(`  placed ${quotes.length} order(s) via WS total — rqs: ${rqs.join(",") || "none"}`);
    this.lastOrderIds.clear();
    // Poll briefly for the orders to appear in our WS snapshot (OrdersUpdate/mt:24 or snapshot push).
    // Server must forward (fw=true) + lb <= head + market.order_ttl_blocks (6 for BTC) for on-chain/UI visibility.
    // Previous +200 was exceeding ttl => orders dropped (not in snapshot, not in UI).
    for (let w = 0; w < 8; w++) {
      await new Promise(r => setTimeout(r, 150));
      const nowCount = this.tradingWs?.openOrdersByPerp?.get(Number(this.cfg.perpId))?.size || this.tradingWs?.openOrders?.size || 0;
      if (nowCount >= quotes.length) break;
    }
    const opensAfter = this.tradingWs?.openOrdersByPerp?.get(Number(this.cfg.perpId))?.size || this.tradingWs?.openOrders?.size || 0;
    console.log(`  after WS places, current WS open orders in snapshot: ${opensAfter}`);
    if (opensAfter === 0 && quotes.length > 0) {
      console.log(`  (note: orders may appear in snapshot on next cycle; check UI for resting orders with oids from prior rqs)`);
    }
  }

  async runCycle(accountId: bigint): Promise<void> {
    const now = new Date().toISOString();
    console.log(`\n[${now}] MM cycle — perp ${this.cfg.perpId}`);

    const { mark, priceDec, lotDec, info } = await this.getMarkAndDecimals(this.cfg.perpId);
    console.log(`  last: $${mark.toFixed(Math.min(2, priceDec))}  | OI L/S: ${this.unscale(info.longOpenInterestLNS, lotDec).toFixed(4)} / ${this.unscale(info.shortOpenInterestLNS, lotDec).toFixed(4)}`);

    // Position with correct decimals
    const posInfo = await this.getCurrentPosition(this.cfg.perpId, accountId, lotDec);
    const signedPos = posInfo.size;
    const sideStr = posInfo.side === "NONE" ? "FLAT" : posInfo.side;
    console.log(`  position: ${sideStr} ${Math.abs(signedPos).toFixed(6)} lots`);

    // Cancel previous
    await this.cancelKnownOrders();

    // Small delay after cancel before place, to let cancels propagate.
    if (this.live) {
      await new Promise(r => setTimeout(r, 1500));
    }

    // Compute + place. Always exactly the requested full size on BOTH sides for bbo (or ladder for spread).
    const quotes = this.calculateQuotes(mark, signedPos, priceDec, lotDec);
    // Log human prices for the sides we are actually quoting (may be one side if over max-pos)
    if (quotes.length > 0) {
      let bp = 0, ap = 0;
      for (const q of quotes) {
        const p = this.unscale(q.pricePNS, priceDec);
        if (q.orderType === OrderType.OpenLong) bp = p;
        else if (q.orderType === OrderType.OpenShort) ap = p;
      }
      if (bp || ap) {
        console.log(`  target quotes: BID ${bp ? bp.toFixed(priceDec) : "-"} / ASK ${ap ? ap.toFixed(priceDec) : "-"}  size=$${this.cfg.orderSizeUsd} lev=${this.cfg.leverage}x`);
      }
    }
    await this.placeQuotes(quotes);

    // Small delay after place to let orders propagate.
    if (this.live) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log("Connecting to Perpl mainnet...");
    const account = await this.client.getAccount();
    if (!account || account.accountId === 0n) {
      throw new Error(
        `No exchange account for ${this.client.address}. Create one first (approve + createAccount on ${this.client.exchangeAddress}). See README.`
      );
    }
    console.log(`Account ID: ${account.accountId}  balanceCNS: ${account.balanceCNS}`);

    if (this.fullConfig) {
      // Public market-data WS for live latest/last price (lst) per the api-docs websocket.md
      // Subscribe to market-state@chain so quoting uses real last price (instead of mark).
      // This is cheap/public (no auth) and gives fresher lst than on-chain polling.
      this.marketDataWs = new MarketDataWsClient({
        wsUrl: this.fullConfig.wsUrl,
        chainId: this.fullConfig.chainId,
      });
      console.log("[MM] Initializing market data WS for latest price (lst)...");
      this.marketDataWs.connect().catch((e: any) => console.log("[MD] connect warning (fallback to on-chain lastPNS):", e?.message || e));
      // Brief wait so first market-state (mt:9) can arrive with lst before we compute first quotes.
      await new Promise((r) => setTimeout(r, 600));
    }

    if (this.live && this.fullConfig) {
      this.tradingWs = new TradingWsClient({
        wsUrl: this.fullConfig.wsUrl,
        apiUrl: this.fullConfig.apiUrl,
        chainId: this.fullConfig.chainId,
        privateKey: this.fullConfig.privateKey,
        exchangeAddress: this.fullConfig.exchangeAddress,
        rpcUrl: this.fullConfig.rpcUrl,
      });
      console.log("[MM] Initializing trading WS (one-click style)...");
      try {
        await this.tradingWs.connect();
        console.log("[MM] Trading WS connected and authed.");
      } catch (e: any) {
        console.log("[MM] Trading WS initial connect failed (will retry on use via ensure):", e.message || e);
        // proceed; ensureConnected will handle reconnect attempts in cycles
      }
    }

    const { mark } = await this.getMarkAndDecimals(this.cfg.perpId);
    console.log(`Starting ${this.cfg.strategy.toUpperCase()} market maker on perp ${this.cfg.perpId} @ last ~$${mark.toFixed(2)}`);
    console.log(`Mode: ${this.live ? "LIVE (real txs)" : "DRY-RUN (no txs)"}  |  Ctrl+C to stop & cancel`);
    if (this.live) {
      console.log("⚠️  WS version (expt clone): PURE WS for placement (mt:22 OrderRequest) + cancels (mt:22 t=5) + snapshots/auth/heartbeats.");
      console.log("   No per-order onchain exec/gas from EOA (unlike main hybrid). Still requires on-chain Exchange account (createAccount).");
      console.log("   Orders submitted like UI one-click trading. Monitor via UI. If fw=false in WalletSnapshot, orders may not appear on-chain.\n");
    } else {
      console.log("\n");
    }

    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runCycle(account.accountId);
      } catch (e: any) {
        console.error("cycle error:", e.message || e);
      }
    };

    await tick();

    const iv = setInterval(tick, this.cfg.intervalMs);

    const shutdown = async () => {
      console.log("\nShutting down — cancelling tracked orders...");
      this.running = false;
      clearInterval(iv);
      try {
        await this.cancelKnownOrders();
      } catch {}
      if (this.tradingWs) {
        try { this.tradingWs.close(); } catch {}
      }
      if (this.marketDataWs) {
        try { this.marketDataWs.close(); } catch {}
      }
      console.log("Done.");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
