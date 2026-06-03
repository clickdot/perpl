/**
 * Minimal ABIs for Perpl mainnet market maker.
 * Sourced from PerplFoundation/dex-sdk + PerplBot contracts/abi.ts
 */

export const ERC20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

export const ExchangeAbi = [
  // Account
  {
    type: "function",
    name: "createAccount",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [{ name: "accountId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getAccountByAddr",
    inputs: [{ name: "accountAddress", type: "address" }],
    outputs: [
      {
        name: "accountInfo",
        type: "tuple",
        components: [
          { name: "accountId", type: "uint256" },
          { name: "balanceCNS", type: "uint256" },
          { name: "lockedBalanceCNS", type: "uint256" },
          { name: "frozen", type: "uint8" },
          { name: "accountAddr", type: "address" },
          {
            name: "positions",
            type: "tuple",
            components: [
              { name: "bank1", type: "uint256" },
              { name: "bank2", type: "uint256" },
              { name: "bank3", type: "uint256" },
              { name: "bank4", type: "uint256" },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Perp info (mark, decimals, OI, etc.)
  {
    type: "function",
    name: "getPerpetualInfo",
    inputs: [{ name: "perpId", type: "uint256" }],
    outputs: [
      {
        name: "perpetualInfo",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "priceDecimals", type: "uint256" },
          { name: "lotDecimals", type: "uint256" },
          { name: "linkFeedId", type: "bytes32" },
          { name: "priceTolPer100K", type: "uint256" },
          { name: "marginTol", type: "uint256" },
          { name: "marginTolDecimals", type: "uint256" },
          { name: "refPriceMaxAgeSec", type: "uint256" },
          { name: "positionBalanceCNS", type: "uint256" },
          { name: "insuranceBalanceCNS", type: "uint256" },
          { name: "markPNS", type: "uint256" },
          { name: "markTimestamp", type: "uint256" },
          { name: "lastPNS", type: "uint256" },
          { name: "lastTimestamp", type: "uint256" },
          { name: "oraclePNS", type: "uint256" },
          { name: "oracleTimestampSec", type: "uint256" },
          { name: "longOpenInterestLNS", type: "uint256" },
          { name: "shortOpenInterestLNS", type: "uint256" },
          { name: "fundingStartBlock", type: "uint256" },
          { name: "fundingRatePct100k", type: "int16" },
          { name: "absFundingClampPctPer100K", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "basePricePNS", type: "uint256" },
          { name: "maxBidPriceONS", type: "uint256" },
          { name: "minBidPriceONS", type: "uint256" },
          { name: "maxAskPriceONS", type: "uint256" },
          { name: "minAskPriceONS", type: "uint256" },
          { name: "numOrders", type: "uint256" },
          { name: "ignOracle", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Position
  {
    type: "function",
    name: "getPosition",
    inputs: [
      { name: "perpId", type: "uint256" },
      { name: "accountId", type: "uint256" },
    ],
    outputs: [
      {
        name: "positionInfo",
        type: "tuple",
        components: [
          { name: "accountId", type: "uint256" },
          { name: "nextNodeId", type: "uint256" },
          { name: "prevNodeId", type: "uint256" },
          { name: "positionType", type: "uint8" },
          { name: "depositCNS", type: "uint256" },
          { name: "pricePNS", type: "uint256" },
          { name: "lotLNS", type: "uint256" },
          { name: "entryBlock", type: "uint256" },
          { name: "pnlCNS", type: "uint256" },
          { name: "deltaPnlCNS", type: "uint256" },
          { name: "premiumPnlCNS", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Core order execution (use execOrders for batch cancel/place)
  {
    type: "function",
    name: "execOrder",
    inputs: [
      {
        name: "orderDesc",
        type: "tuple",
        components: [
          { name: "orderDescId", type: "uint256" },
          { name: "perpId", type: "uint256" },
          { name: "orderType", type: "uint8" },
          { name: "orderId", type: "uint256" },
          { name: "pricePNS", type: "uint256" },
          { name: "lotLNS", type: "uint256" },
          { name: "expiryBlock", type: "uint256" },
          { name: "postOnly", type: "bool" },
          { name: "fillOrKill", type: "bool" },
          { name: "immediateOrCancel", type: "bool" },
          { name: "maxMatches", type: "uint256" },
          { name: "leverageHdths", type: "uint256" },
          { name: "lastExecutionBlock", type: "uint256" },
          { name: "amountCNS", type: "uint256" },
          { name: "maxSlippageBps", type: "uint256" },
        ],
      },
    ],
    outputs: [
      {
        name: "signature",
        type: "tuple",
        components: [
          { name: "perpId", type: "uint256" },
          { name: "orderId", type: "uint256" },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execOrders",
    inputs: [
      {
        name: "orderDescs",
        type: "tuple[]",
        components: [
          { name: "orderDescId", type: "uint256" },
          { name: "perpId", type: "uint256" },
          { name: "orderType", type: "uint8" },
          { name: "orderId", type: "uint256" },
          { name: "pricePNS", type: "uint256" },
          { name: "lotLNS", type: "uint256" },
          { name: "expiryBlock", type: "uint256" },
          { name: "postOnly", type: "bool" },
          { name: "fillOrKill", type: "bool" },
          { name: "immediateOrCancel", type: "bool" },
          { name: "maxMatches", type: "uint256" },
          { name: "leverageHdths", type: "uint256" },
          { name: "lastExecutionBlock", type: "uint256" },
          { name: "amountCNS", type: "uint256" },
          { name: "maxSlippageBps", type: "uint256" },
        ],
      },
      { name: "revertOnFail", type: "bool" },
    ],
    outputs: [
      {
        name: "signatures",
        type: "tuple[]",
        components: [
          { name: "perpId", type: "uint256" },
          { name: "orderId", type: "uint256" },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  // Events we can listen to later for reactive MM
  {
    type: "event",
    name: "OrderRequest",
    inputs: [
      { name: "perpId", type: "uint256", indexed: false },
      { name: "accountId", type: "uint256", indexed: false },
      { name: "orderDescId", type: "uint256", indexed: false },
      { name: "orderId", type: "uint256", indexed: false },
      { name: "orderType", type: "uint8", indexed: false },
      { name: "pricePNS", type: "uint256", indexed: false },
      { name: "lotLNS", type: "uint256", indexed: false },
      { name: "expiryBlock", type: "uint256", indexed: false },
      { name: "postOnly", type: "bool", indexed: false },
      { name: "fillOrKill", type: "bool", indexed: false },
      { name: "immediateOrCancel", type: "bool", indexed: false },
      { name: "maxMatches", type: "uint256", indexed: false },
      { name: "leverageHdths", type: "uint256", indexed: false },
      { name: "lastExecutionBlock", type: "uint256", indexed: false },
      { name: "amountCNS", type: "uint256", indexed: false },
      { name: "maxSlippageBps", type: "uint256", indexed: false },
      { name: "gasLeft", type: "uint256", indexed: false },
    ],
  },
] as const;

// OrderType enum (matches contract + PerplBot/ dex-sdk)
export enum OrderType {
  OpenLong = 0,
  OpenShort = 1,
  CloseLong = 2,
  CloseShort = 3,
  Cancel = 4,
  Change = 5,
}

export interface OrderDesc {
  orderDescId: bigint;
  perpId: bigint;
  orderType: OrderType;
  orderId: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  expiryBlock: bigint;
  postOnly: boolean;
  fillOrKill: boolean;
  immediateOrCancel: boolean;
  maxMatches: bigint;
  leverageHdths: bigint;
  lastExecutionBlock: bigint;
  amountCNS: bigint;
  maxSlippageBps: bigint;
}
