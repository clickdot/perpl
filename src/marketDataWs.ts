/**
 * Public market data WebSocket client.
 * Used to consume real-time "latest price" (lst / last price) from market-state stream
 * instead of (or in addition to) on-chain mark price.
 *
 * See: https://github.com/PerplFoundation/api-docs/blob/main/websocket.md
 *   - Connect to /ws/v1/market-data (no auth)
 *   - mt:5 SubscriptionRequest for "market-state@<chain>"
 *   - mt:9 MarketStateUpdate with .d[marketId].lst (scaled last price)
 */

import WebSocket from "ws";

export interface MarketDataWsConfig {
  wsUrl: string;
  chainId: number;
}

export class MarketDataWsClient {
  private ws?: WebSocket;
  private config: MarketDataWsConfig;
  public connected = false;
  private shouldReconnect = true;
  private heartbeatInterval: any = null;

  // marketId -> last price info (values are scaled per the market's priceDecimals, as numbers from WS)
  public marketStates: Map<number, { lst: number; mrk?: number; mid?: number; bid?: number; ask?: number }> = new Map();

  constructor(config: MarketDataWsConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const url = `${this.config.wsUrl}/ws/v1/market-data`;
    this.ws = new WebSocket(url);

    return new Promise((resolve) => {
      if (!this.ws) return resolve();

      this.ws.on("open", () => {
        // Subscribe to market-state for prices (last, mark, mid, bbo etc)
        const msg = {
          mt: 5, // SubscriptionRequest
          subs: [
            { stream: `market-state@${this.config.chainId}`, subscribe: true },
          ],
        };
        try {
          this.ws!.send(JSON.stringify(msg));
        } catch {}
        this.connected = true;
        this.startHeartbeat();
        // Resolve quickly; updates will arrive
        setTimeout(() => resolve(), 100);
      });

      // transport ping/pong
      this.ws.on("ping", () => {
        try { this.ws!.pong(); } catch {}
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) {
          console.error("[MD] bad msg", e);
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        console.log(`[MD] closed code=${code} reason=${reason?.toString() || ""}`);
        this.connected = false;
        this.ws = undefined;
        this.stopHeartbeat();
        if (this.shouldReconnect) {
          setTimeout(() => this.reconnect(), 1500);
        }
      });

      this.ws.on("error", (e: any) => {
        // 520 etc are transient (often proxy); reconnect logic in close will handle
        if (e && (e.message || '').includes('520')) {
          console.log("[MD] transient 520 (reconnecting...)");
        } else {
          console.error("[MD] error", e?.message || e);
        }
      });

      // safety resolve
      setTimeout(() => resolve(), 4000);
    });
  }

  private handleMessage(msg: any) {
    const mt = msg.mt;

    if (mt === 6 /* SubscriptionResponse */) {
      // ok
    }

    if (mt === 9 /* MarketStateUpdate */) {
      const d = (msg.d || {}) as Record<string, any>;
      for (const [mktStr, state] of Object.entries(d)) {
        if (!state) continue;
        const mkt = Number(mktStr);
        if (!Number.isFinite(mkt)) continue;
        this.marketStates.set(mkt, {
          lst: Number((state as any).lst ?? 0),
          mrk: (state as any).mrk != null ? Number((state as any).mrk) : undefined,
          mid: (state as any).mid != null ? Number((state as any).mid) : undefined,
          bid: (state as any).bid != null ? Number((state as any).bid) : undefined,
          ask: (state as any).ask != null ? Number((state as any).ask) : undefined,
        });
      }
    }

    // mt:100 heartbeat etc ignored for price
  }

  getLastPrice(marketId: number): number | undefined {
    const s = this.marketStates.get(marketId);
    if (!s || !s.lst || s.lst <= 0) return undefined;
    return s.lst;
  }

  getMarketState(marketId: number) {
    return this.marketStates.get(marketId);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.connected) {
        try {
          this.ws.send(JSON.stringify({ mt: 1, t: Date.now() })); // app-level ping
        } catch {}
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async reconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    try {
      await this.connect();
      console.log("[MD] reconnected successfully");
    } catch (e) {
      console.error("[MD] reconnect failed", e);
      if (this.shouldReconnect) {
        setTimeout(() => this.reconnect(), 5000);
      }
    }
  }

  close() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }
}
