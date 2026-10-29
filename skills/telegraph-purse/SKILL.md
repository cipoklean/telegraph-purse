---
name: telegraph-purse
description: Buy fresh, live facts from the Telegraph intelligence network with a capped USDC purse instead of guessing. Activate when the user needs a current crypto price, current weather or temperature, a live web search, or any fact that changes over time and that you cannot know from training data. Do not activate for stable knowledge, opinions, writing, maths, or code.
license: MIT
metadata:
  version: 0.1.0
  requires: telegraph-purse MCP server (node dist/index.js) with a funded test wallet
---

# Telegraph Purse

You have a small wallet that pays per answer (about $0.01) on the Telegraph network. Spending is capped per call and per day, and every purchase leaves a receipt.

## When to buy
Buy only when the answer is live or recent and your own knowledge would be stale:
- Prices: `purse_ask` intent `CRYPTO_PRICE_USD`, params `{ "symbol": "BTC" }`
- Weather now: intent `WEATHER_CHECK_TEMPERATURE`, params `{ "location": "Lagos" }`
- Fresh web results: intent `WEB_SEARCH_GENERAL`, params `{ "query": "..." }`
- Anything else live: `purse_ask` with a plain `query`, or check `purse_intents` first.

Never buy for: definitions, history, maths, code, drafting, or something you already answered in this conversation. Reuse a purchase from the last few minutes instead of buying again.

## How to buy
1. Always fill `why` with one line on why live data is needed.
2. If unsure what it costs, call `purse_quote` first (free).
3. Call `purse_ask` once. One routed miner per question; never ask several times to compare.
4. In your reply, give the answer, then a short footer: cost, miner, and the receipt hash.

## When it fails
- `BLOCKED by budget`: tell the user the cap was reached; don't retry. They can raise `PURSE_DAILY_CAP_USD`.
- `FAILED (not charged)`: say live data is unavailable right now and answer from your knowledge, clearly labelled as possibly out of date. Retry at most once.

## Free tools
`purse_budget` (spend vs caps), `purse_receipts` (recent purchases), `purse_balance` (wallet USDC), `purse_intents` (live intents), `purse_verify` (prove a purchase by signal hash).
