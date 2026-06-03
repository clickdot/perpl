/**
 * Mainnet-first config for Perpl market maker.
 * Defaults come from https://github.com/PerplFoundation/api-docs
 */
import "dotenv/config";
import type { Address } from "viem";

export interface PerplConfig {
  rpcUrl: string;
  exchangeAddress: Address;
  collateralToken: Address;
  privateKey: `0x${string}`;
  live: boolean;
  apiUrl: string;
  wsUrl: string;           // base for /ws/v1/...
  tradingWsUrl: string;    // full trading endpoint
  chainId: number;
}

export const DEFAULTS = {
  rpcUrl: "https://rpc.monad.xyz",
  exchangeAddress: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F" as Address,
  collateralToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
  chainId: 143,
  apiUrl: "https://app.perpl.xyz/api",
  wsUrl: "wss://app.perpl.xyz",
};

export function loadConfig(): PerplConfig {
  const privateKey = (process.env.PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY) as `0x${string}` | undefined;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is required (0x...)");
  }
  if (!privateKey.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
  }

  const rpcUrl = process.env.RPC_URL || DEFAULTS.rpcUrl;
  const exchangeAddress = (process.env.EXCHANGE_ADDRESS || DEFAULTS.exchangeAddress) as Address;
  const collateralToken = (process.env.COLLATERAL_TOKEN || DEFAULTS.collateralToken) as Address;

  const apiUrl = process.env.PERPL_API_URL || DEFAULTS.apiUrl;
  const wsBase = process.env.PERPL_WS_URL || DEFAULTS.wsUrl;
  const tradingWsUrl = `${wsBase}/ws/v1/trading`;
  const chainId = parseInt(process.env.PERPL_CHAIN_ID || String(DEFAULTS.chainId), 10);

  // LIVE=true (or LIVE=1) enables real txs. Default = dry run only.
  const live = ["true", "1", "yes"].includes((process.env.LIVE || "").toLowerCase());

  return {
    rpcUrl,
    exchangeAddress,
    collateralToken,
    privateKey,
    live,
    apiUrl,
    wsUrl: wsBase,
    tradingWsUrl,
    chainId,
  };
}

export const PERP_SYMBOLS: Record<string, bigint> = {
  btc: 1n,
  mon: 10n,
  eth: 20n,
  sol: 30n,
};

export function resolvePerpId(input: string | number): bigint {
  if (typeof input === "number" || /^\d+$/.test(String(input))) {
    return BigInt(input);
  }
  const key = String(input).toLowerCase();
  if (key in PERP_SYMBOLS) return PERP_SYMBOLS[key];
  // fallback: try parse
  const n = BigInt(input);
  if (n > 0n) return n;
  throw new Error(`Unknown perp: ${input}. Use id (1,10,20,30) or btc/mon/eth/sol`);
}
