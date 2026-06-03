# perpl-market-maker-ts (WS version)

**WebSocket / "one click trading" style version** of the Perpl mainnet market maker.

This version uses the authenticated trading WebSocket (wss://app.perpl.xyz/ws/v1/trading) for order submission (after doing the SIWE auth once), similar to how the Perpl UI works with "one click trading" enabled. This matches the fast session-based flow you see in the UI (no per-order EVM tx signing prompts from a local key in the same way; orders go through their trading infrastructure).

See the sibling `perpl-direct-onchain-mm/` for the pure direct-on-chain version (raw `execOrders` via viem to the Exchange contract every cycle). That one is "always on-chain direct", visible txs, gas per re-quote, full control.

## Current status
- Direct on-chain path has been moved/cloned to the sibling.
- This one is being converted to WS-only for order placement (market data reads can stay on contract or public WS).
- Account on-chain is still required (createAccount on Exchange for ID 824 etc.).
- Uses your private key for the initial REST auth (payload sign + connect) to get trading session, then WS for orders.

## Why two versions?
- Direct-onchain: maximum independence from Perpl's API layer for execution.
- WS: matches UI UX, potentially lower latency for order ack, uses the same path as one-click trading (session/nonce based).

Both share the same .env key and mainnet config for now.

## Usage
After npm install (and the WS client code is complete):

LIVE=true npm run dev -- --perp 1 --size 0.00002 --leverage 10 ...

See the cloned direct version's history for the working direct implementation.

## Next steps in this version (WS)
- Implement full auth (REST payload + sign + connect to get nonce).
- Connect to trading WS, AuthSignIn.
- Translate BBO/spread logic to WS order messages (instead of building OrderDesc and execOrders).
- Keep contract reads for getAccount, getPosition, getPerpetualInfo (or use public market WS for marks).
- Handle fills/position updates from WS if possible.
- Graceful shutdown (cancel via WS).

The direct-onchain sibling is the "known working" reference.
