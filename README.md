# Telegraph Purse

A capped USDC purse that lets a personal agent (Hermes, or any MCP client) buy live intelligence from the [Telegraph](https://telegraphprotocol.com) network instead of guessing. Built for Telegraph Hackathon Season II, Mission 09: Personal Agent.

**Why:** an agent with a raw wallet can overspend, buy things it already knows, and leave no trail. The purse adds the three things a person needs before handing an agent money:

1. **Caps**: a per-call and a daily limit, checked after Telegraph's price challenge and before anything is signed. A second, hard per-payment cap sits in the x402 client itself.
2. **Policy**: a Hermes skill that only buys live facts (prices, weather now, fresh search) and requires a one-line `why` for every purchase.
3. **Receipts**: every purchase, block and failure lands in a local ledger with intent, miner, cost, latency, signal hash, Telegraph receipt hash and settlement tx.

## What it looks like
```text
> what is the BTC price in USD right now?

Hermes: Using telegraph-purse to buy the live BTC price fact.
  Purse · purse_ask

Hermes: BTC is $77,848.80 USD right now.
Cost $0.01 · miner Cp Coinbase (#190069) · receipt 0xef018ec2c0a04b79…2fbe8e
```
(Hermes session on Nov 1, 2026. The settlement for this exact purchase is the first row under Evidence.)

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
git clone https://github.com/cipoklean/telegraph-purse.git && cd telegraph-purse
npm install
npm run setup   # builds, makes a burner wallet in .env, mints 5 test USDC if it has Sepolia ETH,
                # installs the Hermes skill and prints the MCP entry to paste
npm run probe   # free smoke test: live intents + price quotes
```
No Sepolia ETH yet? Send the printed address a little from any Sepolia faucet and run `npm run setup` again. Then paste the printed `purse:` entry under `mcp_servers:` in `~/.hermes/config.yaml` and run `hermes mcp test purse`.

## Settings (`.env`)
| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAPH_EVM_PRIVATE_KEY` | set by `npm run setup` | Burner wallet that pays. Never use a wallet with real funds. |
| `PURSE_MAX_PER_CALL_USD` | `0.05` | Highest price one answer may cost |
| `PURSE_DAILY_CAP_USD` | `0.50` | Most the purse spends per UTC day |
| `PURSE_ALLOWED_INTENTS` | empty (all) | Optional comma list, e.g. `CRYPTO_PRICE_USD,WEATHER_CHECK_TEMPERATURE` |
| `PURSE_TIMEOUT_MS` | `60000` | Give up on an answer after this long |
| `PURSE_PIN_MINERS` | `WEATHER_CHECK_TEMPERATURE=20260821` | `intent=minerId` pairs sent to one miner via `/engine/v1/ask/{miner}`, still paid through Telegraph. Empty = auto-route |
| `PURSE_LEDGER` | `~/.telegraph-purse/ledger.jsonl` | Where receipts are written |
| `TELEGRAPH_NODE_URL` | `https://devnode.telegraphprotocol.com` | Telegraph node |

Hermes can add its own per-chat limit on top, in the same `purse:` entry:
```yaml
    tool_costs:
      purse_ask: 1
    spend_limit: 50
    cost_unit: cents
```

## Receipts
One JSON line per attempt. `status` is `paid`, `blocked` (a cap or the allow-list stopped it before signing), `failed` (no payment signed) or `failed_paid` (payment signed, no answer). Spend from `paid` and `failed_paid` both count toward the caps. A real row:
```json
{"ts":"2026-11-01T18:13:44Z","status":"paid","intent":"CRYPTO_PRICE_USD","params":{"symbol":"BTC"},
 "why":"User wants the current BTC price in USD, which changes continuously and is beyond training data.",
 "miner_id":"190069","miner_name":"Cp Coinbase","cost_usd":0.01,"duration_ms":263,
 "signal_hash":"0x1884a9daa4f96341e0c6ed8028c3d16f9127a733bf03c990317a5c70000b4e01",
 "receipt_hash":"0xef018ec2c0a04b7932ca32d3bf6e56785fab6c66540ebd68b33b0b344e2fbe8e",
 "tx_hash":"0xb3d0bd7cfa2006bd504a228be96bb31bf59df53066714fed3fa50fcb535917a5","epoch_id":1969}
```
`duration_ms` is the node's reported answer time; the agent-side round trip, including payment, is longer.

## Evidence (Season II, testnet)
Autonomous purchases by a Hermes agent through Telegraph, paid in test USDC on Ethereum Sepolia from wallet `0x51b0228bd9B8BF78CEDB11Cb485BA9F80cCf4655`.

| Time (UTC) | Intent | Answer | Cost | Settlement |
|---|---|---|---|---|
| 2026-11-01 18:13:44 | `CRYPTO_PRICE_USD` BTC | $77,848.80 | 0.01 USDC | [0xb3d0bd7c…17a5](https://sepolia.etherscan.io/tx/0xb3d0bd7cfa2006bd504a228be96bb31bf59df53066714fed3fa50fcb535917a5) (block 12042724) |
| 2026-11-01 18:22:47 | `CRYPTO_PRICE_USD` BTC | $77,810 | 0.01 USDC | [0x05af43d7…ebee](https://sepolia.etherscan.io/tx/0x05af43d7be0cd3fd9f6e60dde1eaa7a03afdefc88ba7744854b527290a34ebee) (block 12042769) |

## Network (as of Nov 1, 2026)
The live devnode charges in Telegraph test USDC `0xcc194e1a843B658526D0D5C431f670028582Ae17` on **Ethereum Sepolia** (`eip155:11155111`), not Base Sepolia as parts of the docs say. `npm run setup` mints test USDC from that contract; the Anjoman faucet also gives it out.

## Known issue found on Nov 1, 2026
The weather miner's tunnel was down (Cloudflare error 1033). The node answered HTTP 500 but still settled the 0.01 USDC payment for those asks. The first version logged them as "not charged". The purse now records any failure after a signed payment as `failed_paid`, counts it against the caps, and the skill tells the agent not to retry that miner. Diagnosis: the router kept picking miner 0 (Lacre-Meteo), whose host returns Cloudflare 1033, although Telegraph's docs say payment settles only on success. Weather is now pinned to miner 20260821 (Amanat, Open-Meteo), which answered Lagos 28.7 °C on Nov 1 in a sandbox test. `purse_ask` also takes an optional `miner`.

## Status
Testnet only. MCP server, Hermes skill, caps and receipts working end to end on a Hermes v0.22 agent.
