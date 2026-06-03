#!/usr/bin/env tsx
/**
 * Quick market liveness check for Perpl mainnet.
 * If PRIVATE_KEY is set, also checks whether the wallet has an on-chain exchange account.
 */
import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeAbi } from "./abi.js";
import { DEFAULTS } from "./config.js";

const RPC = process.env.RPC_URL || DEFAULTS.rpcUrl;
const EX = (process.env.EXCHANGE_ADDRESS || DEFAULTS.exchangeAddress) as Address;
const PK = (process.env.PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY) as `0x${string}` | undefined;

const client = createPublicClient({ transport: http(RPC) });

const MARKETS = [1n, 10n, 20n, 30n];

async function main() {
  console.log("Perpl mainnet market check\n");
  console.log(`RPC: ${RPC}`);
  console.log(`Exchange: ${EX}\n`);

  if (PK) {
    try {
      const addr = privateKeyToAccount(PK).address;
      const acct: any = await client.readContract({
        address: EX,
        abi: ExchangeAbi,
        functionName: "getAccountByAddr",
        args: [addr],
      });
      console.log(`Wallet: ${addr}`);
      console.log(`Account ID: ${acct.accountId} (0 = none — createAccount required to trade)\n`);
    } catch {
      console.log("Wallet key present but getAccountByAddr reverted (no account or other error)\n");
    }
  }

  console.log("ID | Symbol | Mark       | Dec | OI Long     | OI Short    | Status");
  console.log("---|--------|------------|-----|-------------|-------------|--------");

  for (const id of MARKETS) {
    try {
      const p: any = await client.readContract({
        address: EX,
        abi: ExchangeAbi,
        functionName: "getPerpetualInfo",
        args: [id],
      });
      const mark = Number(p.markPNS) / 10 ** Number(p.priceDecimals);
      const oiL = Number(p.longOpenInterestLNS) / 10 ** Number(p.lotDecimals);
      const oiS = Number(p.shortOpenInterestLNS) / 10 ** Number(p.lotDecimals);
      const sym = p.symbol || "?";
      const status = p.status === 0 ? "active" : `st=${p.status}`;
      console.log(
        `${String(id).padEnd(2)} | ${sym.padEnd(6)} | ${mark.toFixed(2).padEnd(10)} | ${String(p.priceDecimals).padEnd(3)} | ${oiL.toFixed(4).padStart(11)} | ${oiS.toFixed(4).padStart(11)} | ${status}`
      );
    } catch (e: any) {
      console.log(`${String(id).padEnd(2)} | error  | ${e.shortMessage || e.message}`);
    }
  }
}

main().catch(console.error);
