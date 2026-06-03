/**
 * Thin viem-based client for Perpl Exchange (mainnet).
 * Focused on what a market maker needs: account, position, perp info, exec orders.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Account,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeAbi, type OrderDesc, OrderType } from "./abi.js";
import type { PerplConfig } from "./config.js";

export interface PerpetualInfo {
  name: string;
  symbol: string;
  priceDecimals: bigint;
  lotDecimals: bigint;
  markPNS: bigint;
  lastPNS: bigint;
  oraclePNS: bigint;
  longOpenInterestLNS: bigint;
  shortOpenInterestLNS: bigint;
  fundingRatePct100k: number; // int16
  status: number;
  paused: boolean;
}

export interface AccountInfo {
  accountId: bigint;
  balanceCNS: bigint;
  lockedBalanceCNS: bigint;
}

export interface PositionInfo {
  accountId: bigint;
  positionType: number; // 0 long, 1 short
  lotLNS: bigint;
  pricePNS: bigint; // entry
  pnlCNS: bigint;
}

export class PerplClient {
  public readonly publicClient: PublicClient;
  public readonly walletClient: WalletClient;
  public readonly account: Account;
  public readonly address: Address;
  public readonly exchangeAddress: Address;

  private exchange: any; // viem contract instance

  constructor(config: PerplConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.address = this.account.address;
    this.exchangeAddress = config.exchangeAddress;

    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      transport: http(config.rpcUrl),
    });

    // dynamic contract
    this.exchange = {
      address: config.exchangeAddress,
      abi: ExchangeAbi,
    } as const;
  }

  async getAccount(): Promise<AccountInfo | null> {
    try {
      const res: any = await this.publicClient.readContract({
        address: this.exchangeAddress,
        abi: ExchangeAbi,
        functionName: "getAccountByAddr",
        args: [this.address],
      });
      return {
        accountId: res.accountId,
        balanceCNS: res.balanceCNS,
        lockedBalanceCNS: res.lockedBalanceCNS,
      };
    } catch (e: any) {
      // Contract reverts (custom error) when no account exists for the address.
      // Treat as "no account".
      if (e.name === "ContractFunctionExecutionError" || /revert|0x/.test(String(e.message))) {
        return null;
      }
      throw e;
    }
  }

  async getPerpetualInfo(perpId: bigint): Promise<PerpetualInfo> {
    const res: any = await this.publicClient.readContract({
      address: this.exchangeAddress,
      abi: ExchangeAbi,
      functionName: "getPerpetualInfo",
      args: [perpId],
    });
    return {
      name: res.name,
      symbol: res.symbol,
      priceDecimals: res.priceDecimals,
      lotDecimals: res.lotDecimals,
      markPNS: res.markPNS,
      lastPNS: res.lastPNS,
      oraclePNS: res.oraclePNS,
      longOpenInterestLNS: res.longOpenInterestLNS,
      shortOpenInterestLNS: res.shortOpenInterestLNS,
      fundingRatePct100k: Number(res.fundingRatePct100k),
      status: Number(res.status),
      paused: res.status !== 0, // 0 = active?
    };
  }

  async getPosition(perpId: bigint, accountId: bigint): Promise<PositionInfo | null> {
    try {
      const res: any = await this.publicClient.readContract({
        address: this.exchangeAddress,
        abi: ExchangeAbi,
        functionName: "getPosition",
        args: [perpId, accountId],
      });
      return {
        accountId: res.accountId,
        positionType: Number(res.positionType),
        lotLNS: res.lotLNS,
        pricePNS: res.pricePNS,
        pnlCNS: res.pnlCNS,
      };
    } catch {
      return null;
    }
  }

  /**
   * Execute one or more OrderDesc.
   * For MM we mostly use execOrders with revertOnFail=false so one bad order doesn't nuke the batch.
   */
  async execOrders(orderDescs: OrderDesc[], revertOnFail = false): Promise<Hash> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.exchangeAddress,
      abi: ExchangeAbi,
      functionName: "execOrders",
      args: [orderDescs as any, revertOnFail],
    });
    const hash = await this.walletClient.writeContract(request);
    return hash;
  }

  async execOrder(orderDesc: OrderDesc): Promise<Hash> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.exchangeAddress,
      abi: ExchangeAbi,
      functionName: "execOrder",
      args: [orderDesc as any],
    });
    const hash = await this.walletClient.writeContract(request);
    return hash;
  }

  /**
   * Cancel all orders for a perp by constructing Cancel OrderDescs.
   * We don't have a direct "get my open orders" view here (would need event indexing or API),
   * so the MM loop is expected to remember the orderIds it placed, or we can accept that
   * on startup we may leave a few orphans that will be cleaned by the first cycle if we track them.
   *
   * For a robust version, subscribe to OrderRequest events or use the trading WS.
   */
  makeCancelDesc(perpId: bigint, orderId: bigint): OrderDesc {
    return {
      orderDescId: 0n,
      perpId,
      orderType: OrderType.Cancel,
      orderId,
      pricePNS: 0n,
      lotLNS: 0n,
      expiryBlock: 0n,
      postOnly: false,
      fillOrKill: false,
      immediateOrCancel: false,
      maxMatches: 0n,
      leverageHdths: 0n,
      lastExecutionBlock: 0n,
      amountCNS: 0n,
      maxSlippageBps: 0n,
    };
  }

  makeOpenDesc(params: {
    perpId: bigint;
    side: "long" | "short";
    pricePNS: bigint;
    lotLNS: bigint;
    leverageHdths: bigint;
    postOnly?: boolean;
  }): OrderDesc {
    return {
      orderDescId: 0n,
      perpId: params.perpId,
      orderType: params.side === "long" ? OrderType.OpenLong : OrderType.OpenShort,
      orderId: 0n,
      pricePNS: params.pricePNS,
      lotLNS: params.lotLNS,
      expiryBlock: 0n,
      postOnly: params.postOnly ?? true,
      fillOrKill: false,
      immediateOrCancel: false,
      maxMatches: 0n,
      leverageHdths: params.leverageHdths,
      lastExecutionBlock: 0n,
      amountCNS: 0n,
      maxSlippageBps: 0n,
    };
  }

  /**
   * Place orders and extract the newly created orderIds.
   * Prefer the return value from simulate (signatures contain the assigned orderIds);
   * fall back to parsing OrderRequest events (which may report 0).
   * This lets the MM track real onchain orderIds for reliable cancel.
   */
  async execOrdersAndTrackIds(orderDescs: OrderDesc[], revertOnFail = false): Promise<{ hash: Hash; orderIds: bigint[] }> {
    const { request, result } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.exchangeAddress,
      abi: ExchangeAbi,
      functionName: "execOrders",
      args: [orderDescs as any, revertOnFail],
    });

    const hash = await this.walletClient.writeContract(request);

    const orderIds: bigint[] = [];
    // Best: the simulated result gives the signatures[] with the orderIds that will be (were) assigned
    if (result && Array.isArray(result)) {
      for (const sig of result) {
        const oid = (sig as any)?.orderId as bigint | undefined;
        if (oid !== undefined && oid > 0n) orderIds.push(oid);
      }
    }

    // Fallback / confirmation: parse events too (note: events currently report oid=0 in this contract)
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({
        abi: ExchangeAbi,
        eventName: "OrderRequest",
        logs: receipt.logs,
      });
      for (const log of logs) {
        const oid = (log.args as any).orderId as bigint | undefined;
        if (oid !== undefined && oid > 0n && !orderIds.includes(oid)) {
          orderIds.push(oid);
        }
      }
    } catch {}

    return { hash, orderIds };
  }

  /**
   * Fallback: scan recent blocks for OrderRequest events from our account on this perp,
   * and return the orderIds (useful when tracking was lost or on startup).
   * Now uses proper event parsing for reliability (no more brittle hex scan).
   */
  async getRecentOrderIds(perpId: bigint = 0n, blocksBack = 80): Promise<bigint[]> {
    const currentBlock = await this.publicClient.getBlockNumber();
    const fromBlock = currentBlock - BigInt(Math.min(blocksBack, 80));

    const orderRequestTopic = "0x02d2bf39d2355aaa5486487e934403fd3ba3f88c73ab71938cee11931fddeb7b" as `0x${string}`;

    const logs = await (this.publicClient as any).getLogs({
      address: this.exchangeAddress,
      fromBlock,
      toBlock: "latest",
      topics: [[orderRequestTopic]],
    });

    const parsed = parseEventLogs({
      abi: ExchangeAbi,
      eventName: "OrderRequest",
      logs: logs as any,
    });

    const acctInfo = await this.getAccount();
    const acctId = acctInfo?.accountId ?? 0n;

    const orderIds = new Set<bigint>();
    for (const log of parsed) {
      const args = (log as any).args || {};
      if (perpId > 0n && args.perpId !== perpId) continue;
      if (args.accountId === acctId) {
        const oid = args.orderId as bigint | undefined;
        if (oid !== undefined && oid > 0n) {
          orderIds.add(oid);
        }
      }
    }
    return Array.from(orderIds);
  }
}
