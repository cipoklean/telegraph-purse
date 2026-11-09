# Demo runbook (2–5 min) — Telegraph Hackathon Season II, Mission 09

Every beat below is verifiable live. Do them in order on a screen share.

## Setup (before recording)
```bash
cd ~/telegraph-purse
npm run build
node scripts/morning_brief.js   # optional: pre-warm a Morning Brief to show
```
Prereqs: `.env` has the burner key (never shown), purse MCP server running, `~/.telegraph-purse/h2-ledger.jsonl` populated.

## Beat 1 — Budget (0:00–0:30)
Call `purse_budget`. Show: `daily_cap_usd 0.50`, `max_per_call_usd 0.05`, today's spend, per-intent latency. Point out the *two* fences: the pre-sign guard and the hard per-payment cap in the x402 client.

## Beat 2 — A paid buy (0:30–1:30)
Call `purse_ask` for `CRYPTO_PRICE_USD` / `{symbol: "BTC"}` with a `why`. Read the receipt: intent, miner, cost $0.01, `tx_hash`. Show the ledger row appended.

## Beat 3 — Receipt verified on Sepolia (1:30–2:30)
Two proofs:
1. `purse_verify` with the purchase's `signal_hash` → node returns the signed payload, request, response, tx hash.
2. Open the tx hash on Etherscan Sepolia (`https://sepolia.etherscan.io/tx/<hash>`) — 0.01 test USDC from `0x51b0228…` to `0x3624EB…`. Balance check: `purse_balance`.

## Beat 4 — Blocked over-cap call (2:30–3:00)
```bash
PURSE_MAX_PER_CALL_USD=0.005 node - <<'JS'
import { ask } from "./dist/purse.js";
try { await ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "demo" }); }
catch (e) { console.log("BLOCKED:", e.message); }
JS
```
Expect: `BLOCKED: price is above the per-call cap $0.005` — no payment signed, nothing on-chain.

## Beat 5 — The Morning Brief (3:00–4:30)
```bash
node scripts/morning_brief.js
```
Shows BTC price + Lagos weather + one web search, each bought through the purse under the daily budget, as one message with three receipts. Open one receipt's tx on Etherscan.

## Notes
- All live data comes through Telegraph via the purse; nothing is called directly.
- Keep the private key off-screen.
- Demo language: "my model proposes, deterministic code enforces — the caps live in code, not in prompts."
