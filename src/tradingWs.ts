/**
 * Trading WebSocket client for Perpl (WS "one click" style order submission).
 *
 * This replaces direct on-chain execOrders for the WS version of the MM.
 *
 * Flow:
 * 1. REST auth (payload + sign + connect) using private key to get nonce.
 * 2. Connect to /ws/v1/trading
 * 3. Send AuthSignIn (mt:4) with nonce.
 * 4. Receive WalletSnapshot (mt:19) etc. — capture account.lfr for rq seeding.
 * 5. Send OrderRequest (mt:22) for opens/cancels/changes.
 * 6. Listen for status, snapshots, updates.
 *
 * Note: Still uses on-chain reads (via the existing PerplClient) for mark/position/account existence.
 * Only order *submission* goes over WS.
 */

import WebSocket from "ws";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount, signMessage } from "viem/accounts";

export interface TradingWsConfig {
  wsUrl: string;
  apiUrl: string;
  chainId: number;
  privateKey: `0x${string}`;
  exchangeAddress: Address; // still needed for some reads if we keep hybrid
  rpcUrl?: string;
}

export interface OrderRequestMsg {
  mt: 22;
  rq: number;      // request id (strictly increasing, seeded from lfr)
  mkt: number;     // market/perp id
  acc: number;     // account id
  oid?: number;    // for cancel/change
  t: number;       // OrderType (API values: 1=OpenLong, 2=OpenShort, 5=Cancel, 7=Change)
  p?: number;      // price scaled
  s: number;       // size scaled
  fl: number;      // OrderFlags (1=PostOnly etc.)
  lv: number;      // leverage * 100 (e.g. 1000 for 10x)
  tif?: number;    // Time-in-force block (last block the order is valid)
  lb: number;      // Last execution block
}

export class TradingWsClient {
  private ws?: WebSocket;
  private config: TradingWsConfig;
  private accountAddr: Address;
  private nonce: string | null = null;
  private lfr: number = 0;           // last filled request, for rq
  private lastHeadBlock: number = 0; // from trading WS mt:100 h, for setting valid lb (order_ttl_blocks is only 6 for BTC!)
  private lastSn: number | undefined; // for seq tracking on heartbeats
  public accId: number = 0;
  public connected = false;
  private pendingAcks = new Map<number, (status: any) => void>();

  // For the MM we also expose a way to get current open orders from snapshots
  public openOrders: Map<number, any> = new Map(); // oid -> order info
  public openOrdersByPerp: Map<number, Map<number, any>> = new Map(); // perp/mkt -> (oid -> order)

  private shouldReconnect = true;
  private heartbeatInterval: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastAuthTime = 0;  // time of last successful WalletSnapshot (sync point for sn)
  private lastHbSn: number | undefined;  // dedicated sequence for mt:100 heartbeats (may be independent of Wallet sn)

  constructor(config: TradingWsConfig) {
    this.config = config;
    const acct = privateKeyToAccount(config.privateKey);
    this.accountAddr = acct.address;
    // For getting current block for lb (last execution block) in orders
    const rpc = config.rpcUrl || "https://rpc.monad.xyz";
    this.publicClient = createPublicClient({ transport: http(rpc) });
  }

  private publicClient: any;

  async authenticate(): Promise<void> {
    const apiUrl = this.config.apiUrl;
    const chainId = this.config.chainId;
    const address = this.accountAddr;

    // 1. Get payload
    const payloadRes = await fetch(`${apiUrl}/v1/auth/payload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain_id: chainId, address }),
    });
    if (!payloadRes.ok) throw new Error(`auth payload failed: ${payloadRes.status}`);
    const payload = await payloadRes.json();

    // 2. Sign (SIWE personal message)
    const signature = await signMessage({
      message: payload.message,
      privateKey: this.config.privateKey,
    });

    // 3. Connect
    const connectRes = await fetch(`${apiUrl}/v1/auth/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain_id: chainId,
        address,
        message: payload.message,
        nonce: payload.nonce,
        issued_at: payload.issued_at,
        mac: payload.mac,
        signature,
      }),
    });
    if (!connectRes.ok) {
      const txt = await connectRes.text();
      throw new Error(`auth connect failed ${connectRes.status}: ${txt}`);
    }
    const auth = await connectRes.json();
    this.nonce = auth.nonce;

    // Capture session cookie (node fetch doesn't auto forward; WS may need it for some setups)
    const setCookie = connectRes.headers.get("set-cookie") || "";
    (this as any)._authCookie = setCookie.split(/,|;/)[0] || "";
    console.log("[WS] Authenticated, nonce ready for trading WS (cookie for WS if required)");
  }

  async connect(): Promise<void> {
    if (!this.nonce) await this.authenticate();

    const url = `${this.config.wsUrl}/ws/v1/trading`;
    const headers: any = {};
    const cookie = (this as any)._authCookie;
    if (cookie) headers.Cookie = cookie;
    this.ws = new WebSocket(url, { headers });

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("no ws"));

      let resolved = false;
      const settle = (fn: () => void) => {
        if (resolved) return;
        resolved = true;
        clearInterval(iv);
        fn();
      };

      const wsForOpen = this.ws;
      this.ws.on("open", () => {
        // Send AuthSignIn immediately
        if (!wsForOpen) return;
        const msg = {
          mt: 4,
          chain_id: this.config.chainId,
          nonce: this.nonce,
          ses: (crypto as any).randomUUID ? (crypto as any).randomUUID() : "sess-" + Date.now(),
        };
        wsForOpen.send(JSON.stringify(msg));
        console.log("[WS] Sent AuthSignIn");
        this.startHeartbeat();
      });

      // Keepalive: reply to pings (transport)
      const wsForPing = this.ws;
      this.ws.on("ping", () => {
        try { if (wsForPing) wsForPing.pong(); } catch {}
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
          if (this.accId > 0 && !resolved) {
            this.connected = true;
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            settle(() => resolve());
          }
        } catch (e) {
          console.error("[WS] bad msg", e);
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        console.log(`[WS] closed code=${code} reason=${reason?.toString() || ''}`);
        this.connected = false;
        this.ws = undefined;
        this.stopHeartbeat();
        if (this.shouldReconnect) {
          // Use centralized scheduler (exponential backoff, single timer) to avoid reconnect storms on 1006 etc.
          // 1006 = abnormal closure (no close frame) — usually remote (LB, server drop, network, session kill) not our send logic.
          this.scheduleReconnect(code === 1006 ? 2000 : undefined);
        }
        if (!resolved) {
          settle(() => reject(new Error(`WS closed before auth: code=${code}`)));
        }
      });

      this.ws.on("error", (e) => {
        console.error("[WS] error", e);
        // will trigger close too usually
        if (!resolved) {
          // let close handle reject
        }
      });

      // Resolve after auth + first snapshot or timeout
      const iv = setInterval(() => {
        if (this.accId > 0) {
          this.connected = true;
          settle(() => resolve());
        }
      }, 200);
      setTimeout(() => {
        clearInterval(iv);
        if (this.accId > 0) {
          this.connected = true;
          this.reconnectAttempts = 0;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          settle(() => resolve());
        } else {
          this.connected = false;
          settle(() => reject(new Error("WS connect/auth timeout: no WalletSnapshot received (check network, nonce, or server)")));
        }
      }, 6000);
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.connected) {
        this.safeSend({ mt: 1 }); // app-level Ping to keepalive
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(delayMs?: number) {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const attempt = this.reconnectAttempts;
    const base = delayMs ?? (1000 * Math.min(Math.pow(2, attempt), 16)); // 1s, 2s, 4s ... cap ~16s
    const delay = Math.min(base, 30000);
    this.reconnectAttempts = Math.min(attempt + 1, 20);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect().catch(() => {});
    }, delay);
  }

  private safeSend(data: any): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      ws.send(payload);
      return true;
    } catch (e: any) {
      console.error("[WS] send error:", e?.message || e);
      return false;
    }
  }

  private async getLbForOrder(buffer = 6): Promise<number> {
    // order_ttl_blocks=6 for BTC (from /api/v1/pub/context), so lb must not exceed head+6 or order may be invalid/rejected for forwarding.
    // Prefer head from trading WS heartbeat (mt:100 .h), fallback to RPC once.
    if (this.lastHeadBlock > 0) {
      return this.lastHeadBlock + buffer;
    }
    try {
      const bn = await this.publicClient.getBlockNumber();
      const head = Number(bn);
      this.lastHeadBlock = head;
      return head + buffer;
    } catch {
      return 0;
    }
  }

  async reconnect() {
    // Clear any pending scheduled reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean current ws *without* forcing .close() on not-yet-established sockets.
    // Calling close() on a WebSocket that never opened (or is still CONNECTING in some states)
    // produces the "WebSocket was closed before the connection was established" error from ws lib.
    // 1006 is abnormal/no-close-frame from remote (network drop, LB kill, server drop, etc.) — common transient.
    if (this.ws) {
      const w = this.ws;
      this.ws = undefined;
      try {
        const rs = w.readyState;
        // Only attempt clean close on sockets that are actually open or connecting in a closable way.
        if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) {
          w.close();
        }
      } catch (e: any) {
        // Swallow the "closed before established" — it's expected during fast-failing reconnects on 1006.
        if (!String(e?.message || e).includes('closed before the connection was established')) {
          console.error('[WS] close during reconnect warning:', e?.message || e);
        }
      }
    }
    this.connected = false;
    this.stopHeartbeat();
    this.lastHbSn = undefined;

    try {
      await this.connect();
      this.reconnectAttempts = 0;
      console.log("[WS] reconnected successfully");
    } catch (e) {
      // For 1006/early auth closes, this is often external (server dropping socket). We back off via scheduleReconnect.
      const msg = (e instanceof Error ? e.message : String(e));
      if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 5 === 0) {
        console.error("[WS] reconnect failed", msg);
      } else {
        // Reduce log spam on repeated 1006 storms
        if (!msg.includes('1006') && !msg.includes('closed before auth')) {
          console.error("[WS] reconnect failed", msg);
        }
      }
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  async ensureConnected() {
    if (this.connected && this.ws && this.accId > 0) return;
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.connect();
      this.reconnectAttempts = 0;
    } catch (e) {
      console.log("[WS] ensure connect failed, will retry later");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  close() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }

  private handleMessage(msg: any) {
    const mt = msg.mt;

    if (msg.rq !== undefined || msg.sr !== undefined || mt === 3) {
      console.log("[WS] msg with rq/sr/status mt=" + mt + ":", JSON.stringify(msg));
    }

    if (mt === 19 /* WalletSnapshot */) {
      // as[0] has the account: id and lfr (last request id for rq seeding)
      const acc = Array.isArray(msg.as) ? msg.as[0] : (msg.d && msg.d.as ? msg.d.as[0] : null);
      if (acc) {
        this.accId = acc.id || acc;
        if (acc.lfr !== undefined) this.lfr = acc.lfr;
        console.log(`[WS] WalletSnapshot acc=${this.accId} lfr=${this.lfr} fw=${acc.fw} fr=${acc.fr} b=${acc.b} lb=${acc.lb}`);
        if (acc.fw === false) {
          console.log("[WS] WARNING: account fw=false (forwarding not allowed). WS placement (mt:22) may not create on-chain orders visible in UI. Enable one-click trading / forwarding in the Perpl UI for this account.");
        }
      }
      if (msg.sn !== undefined) this.lastSn = msg.sn;
      this.lastAuthTime = Date.now();
      this.lastHbSn = undefined;  // reset hb seq on fresh auth/Wallet (new connection's hb stream)
      this.connected = true;
    }

    if (mt === 21 /* AccountUpdate */) {
      const u = msg.d || msg;
      if (u && u.lfr !== undefined) this.lfr = Math.max(this.lfr, u.lfr);
    }

    if (mt === 100 /* Heartbeat */) {
      if (msg.h !== undefined) {
        this.lastHeadBlock = Number(msg.h);
      }
      if (msg.sn !== undefined) {
        const sn = Number(msg.sn);
        if (this.lastHbSn != null && sn > this.lastHbSn + 1) {
          // Real forward gap in the *heartbeat* sequence (per docs, means possible lost messages -> resync by reconnect).
          // We track hb sn *separately* from WalletSnapshot sn (in practice hb sn values are in a different range,
          // e.g. ~block numbers, and duplicates like "78818752 -> 78818752" were arriving, which triggered the old
          // buggy check on every duplicate and caused reconnect storms + "too many connections" 1008).
          // Ignore duplicates (sn == lastHbSn) and old messages. Only force on actual jumps after auth has settled.
          const now = Date.now();
          if (now - this.lastAuthTime > 4000) {
            console.log(`[WS] heartbeat sequence gap ${this.lastHbSn} -> ${sn} — forcing reconnect to resync state`);
            this.scheduleReconnect(2000);
          }
        }
        if (sn > (this.lastHbSn ?? -1)) {
          this.lastHbSn = sn;
        }
      }
    }

    if (mt === 23 /* OrdersSnapshot */) {
      this.openOrders.clear();
      this.openOrdersByPerp.clear();
      const arr = Array.isArray(msg.d) ? msg.d : (msg.d ? [msg.d] : []);
      for (const o of arr) {
        if (o && o.oid != null) {
          const oid = Number(o.oid);
          this.openOrders.set(oid, o);
          const mkt = this.getMkt(o);
          if (mkt) {
            if (!this.openOrdersByPerp.has(mkt)) this.openOrdersByPerp.set(mkt, new Map());
            this.openOrdersByPerp.get(mkt)!.set(oid, o);
          }
        }
      }
      console.log(`[WS] OrdersSnapshot: ${this.openOrders.size} open`);
    }

    if (mt === 24 /* OrdersUpdate */) {
      // d may be array of updates
      const updates = Array.isArray(msg.d) ? msg.d : (msg.d ? [msg.d] : []);
      for (const u of updates) {
        if (!u || u.oid == null) continue;
        const oid = Number(u.oid);
        const mkt = this.getMkt(u);
        if (u.r) { // remove
          this.openOrders.delete(oid);
          if (mkt && this.openOrdersByPerp.has(mkt)) {
            this.openOrdersByPerp.get(mkt)!.delete(oid);
            if (this.openOrdersByPerp.get(mkt)!.size === 0) this.openOrdersByPerp.delete(mkt);
          }
        } else if (oid) {
          this.openOrders.set(oid, u);
          if (mkt) {
            if (!this.openOrdersByPerp.has(mkt)) this.openOrdersByPerp.set(mkt, new Map());
            this.openOrdersByPerp.get(mkt)!.set(oid, u);
          }
        }
      }
    }

    // Handle status for our requests (for acks)
    if (msg.sr !== undefined && msg.rq !== undefined) {
      const cb = this.pendingAcks.get(msg.rq);
      if (cb) {
        cb(msg);
        this.pendingAcks.delete(msg.rq);
      }
    }

    // Heartbeat etc. ignored for now
  }

  private nextRq(): number {
    this.lfr = Math.max(this.lfr, 0);
    const rq = this.lfr + 1;
    this.lfr = rq;
    return rq;
  }

  private getMkt(o: any): number {
    if (!o) return 0;
    const v = o.mkt ?? o.market ?? o.perp ?? o.perpId ?? o.p ?? o.i ?? o.m;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  async placeOrder(params: {
    marketId: number;
    accountId: number;
    side: "long" | "short"; // open long/short
    size: number;           // already scaled? no, pass human then we scale? for now assume caller scaled like before? Wait, we'll pass scaled.
    price: number;          // scaled
    leverageHdths: number;  // e.g. 1000 for 10x
    postOnly?: boolean;
    lastBlock?: number;
  }): Promise<{ rq: number; ack?: any }> {
    const rq = this.nextRq();
    const t = params.side === "long" ? 1 : 2; // API OpenLong=1, OpenShort=2
    const fl = params.postOnly ? 1 : 0;

    let lb = params.lastBlock;
    if (!lb) {
      // Use small buffer: order_ttl_blocks=6 on BTC, must be <= head + ttl or request may not forward to onchain/UI.
      lb = await this.getLbForOrder(6);
    }

    const msg: OrderRequestMsg = {
      mt: 22,
      rq,
      mkt: params.marketId,
      acc: params.accountId || this.accId,
      t,
      p: params.price,
      s: params.size,
      fl,
      lv: params.leverageHdths,
      lb,
    };

    if (!this.ws || !this.connected || !this.accId) {
      throw new Error("WS not authed/connected");
    }
    if (!this.safeSend(msg)) {
      throw new Error("WS send failed (socket not open)");
    }

    console.log(`[WS] OrderRequest rq=${rq} t=${t} mkt=${params.marketId} acc=${params.accountId} p=${params.price} s=${params.size} fl=${fl} lv=${params.leverageHdths} lb=${lb}`);

    // Fire and forget the send + ack wait (to avoid blocking the cycle for up to 8s per order).
    // The status will be handled in pending if arrives, but MM doesn't await long.
    const timeout = setTimeout(() => {
      this.pendingAcks.delete(rq);
    }, 8000);
    this.pendingAcks.set(rq, (status) => {
      clearTimeout(timeout);
      if (status && (status.sr !== undefined || status.st !== undefined || status.s !== undefined)) {
        console.log(`[WS] rq=${rq} status:`, JSON.stringify(status));
      }
    });

    return { rq };
  }

  async cancelOrder(marketId: number, accountId: number, orderId: number): Promise<{ rq: number; ack?: any }> {
    const rq = this.nextRq();
    const lb = await this.getLbForOrder(3);  // smaller buffer for cancel (avoid "last exec block too high" seen on some stale oids)
    const msg = {
      mt: 22,
      rq,
      mkt: marketId,
      acc: accountId,
      oid: orderId,
      t: 5, // Cancel
      s: 0,
      fl: 0,
      lv: 0,
      lb,
    };

    if (!this.ws || !this.connected) throw new Error("not connected");
    if (!this.safeSend(msg)) {
      throw new Error("WS send failed (socket not open)");
    }

    const to = setTimeout(() => {
      this.pendingAcks.delete(rq);
    }, 5000);
    this.pendingAcks.set(rq, (st) => {
      clearTimeout(to);
      if (st && (st.sr !== undefined || st.st !== undefined)) {
        console.log(`[WS] cancel rq=${rq} status:`, JSON.stringify(st));
      }
    });

    return { rq };
  }
}

/**
 * Helper: do the full REST auth and return the nonce for WS.
 * (Used internally by the client, but exposed if needed for other tools.)
 */
export async function getTradingNonce(apiUrl: string, chainId: number, privateKey: `0x${string}`): Promise<string> {
  const address = privateKeyToAccount(privateKey).address;

  const payloadRes = await fetch(`${apiUrl}/v1/auth/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain_id: chainId, address }),
  });
  const payload = await payloadRes.json();

  const signature = await signMessage({ message: payload.message, privateKey });

  const connRes = await fetch(`${apiUrl}/v1/auth/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chain_id: chainId,
      address,
      message: payload.message,
      nonce: payload.nonce,
      issued_at: payload.issued_at,
      mac: payload.mac,
      signature,
    }),
  });
  const auth = await connRes.json();
  return auth.nonce;
}
