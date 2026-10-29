# Telegraph Purse

A capped USDC purse that lets a personal agent (Hermes, or any MCP client) buy live intelligence from the [Telegraph](https://telegraphprotocol.com) network instead of guessing. Telegraph Hackathon Season II, Mission 09: Personal Agent.

**Why:** an agent with a raw wallet can overspend, buy things it already knows, and leave no trail. The purse adds the three things a person needs before handing an agent money:

1. **Caps** – a per-call and a daily limit, checked after Telegraph's price challenge and before anything is signed. A second, hard per-payment cap sits in the x402 client itself.
2. **Policy** – a Hermes skill that only buys live facts (prices, weather now, fresh search) and requires a one-line `why` for every purchase.
3. **Receipts** – every purchase, block and failure lands in a local ledger with intent, miner, cost, latency, signal hash, Telegraph receipt hash and settlement tx.

## Tools (MCP, stdio)
| Tool | Paid | What it does |
|---|---|---|
| `purse_ask` | ~$0.01 | Buy one answer: canonical `intent` + `params`, or a plain `query` |
| `purse_quote` | free | Price of an answer from the 402 challenge, without paying |
| `purse_budget` | free | Spend today vs caps, per-intent cost and latency |
| `purse_receipts` | free | Recent purchases with hashes |
| `purse_balance` | free | Wallet test-USDC balance |
| `purse_intents` | free | Intents with live miners, or one intent's params |
| `purse_verify` | free | Look up a purchase's signal on the node |

## Run
Requires Node 20+.
```bash
npm install && npm run build
cp .env.example .env   # set a burner TELEGRAPH_EVM_PRIVATE_KEY
npm run probe          # free smoke test: live intents + price quotes
```
Hermes: add the server to your MCP config (`command: node`, `args: [/path/to/telegraph-purse/dist/index.js]`) and copy `skills/telegraph-purse/` into your skills folder.

## Network (as of Oct 29, 2026)
The live devnode charges in Telegraph test USDC `0xcc194e1a843B658526D0D5C431f670028582Ae17` on **Ethereum Sepolia** (`eip155:11155111`), not Base Sepolia as parts of the docs say. Test USDC comes from the Anjoman faucet.

## Status
Testnet only. End-to-end paid call verified Oct 29, 2026 (pre-event test): CRYPTO_PRICE_USD BTC, $0.01, 540 ms, miner 9107, with receipt and settlement tx. H2 evidence starts Nov 1.
