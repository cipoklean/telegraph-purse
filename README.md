# Telegraph Purse

**Give your agent a wallet it can't overspend.**

A capped USDC purse that lets a personal agent (Hermes, or any MCP client) buy
live facts from the [Telegraph](https://telegraphprotocol.com) network instead
of guessing. Built for **Telegraph Hackathon Season II — Apps & Agents,
Mission 09: Personal Agent**.

- **On-chain proof:** [Evidence table](#evidence-season-ii-testnet) — every row links its Sepolia settlement
- **Bug report filed with Telegraph:** [reports/telegraph-settlement-report.md](reports/telegraph-settlement-report.md)
- **Agent policy:** [skills/telegraph-purse/SKILL.md](skills/telegraph-purse/SKILL.md)

---

## The Problem & Insight

Telegraph sells live answers (prices, weather, search) for about $0.01 each, paid
per call over x402. That is exactly what a personal agent needs: a fact it
cannot know from training data. But handing an agent a raw wallet means it can
overspend, buy things it already knows, and leave no trail.

The purse sits between the agent and the payment, and adds the three things a
person needs before letting an agent spend:

1. **Caps** — a per-call and a daily limit, checked *after* Telegraph's price
   challenge and *before* anything is signed. A second hard per-payment cap sits
   inside the x402 client; on the escrow rail the signed amount is read verbatim
   off the node's own challenge template, so the pre-sign guard is the fence.
2. **Policy** — a Hermes skill that only buys live facts (prices, weather now,
   fresh search) and requires a one-line `why` for every purchase.
3. **Receipts** — every purchase, block and failure lands in a local ledger with
   intent, miner, cost, latency, signal hash, Telegraph receipt hash and
   settlement reference.

---

## Spending Rules

The purse fails closed. A judge or user can check each rule in `src/purse.ts`
and `test/purse.test.ts`:

- **Nothing is signed over the cap.** The price comes from the node's 402
  challenge; the cap check runs before the signature.
- **A signed failure is still a spend.** If a payment was signed and no answer
  came back, the row is `failed_paid` and it counts against the caps. Found the
  hard way: the node settled 8 failed weather asks on Nov 1.
- **Allow-list means allow-list.** With `PURSE_ALLOWED_INTENTS` set, a plain
  `query` ask is refused, because the node only reveals the routed intent after
  payment.
- **One ask at a time.** Asks are serialized, so two parallel calls cannot both
  pass the daily cap.
- **A miner that keeps failing is quarantined.** After 2 `failed_paid` from the
  same miner (or the same auto-routed intent) within 60 minutes, the purse skips
  it before even asking for a price, so the daily cap is the last line of
  defence, not the first. Suggested by a reader of the dev.to tutorial.
- **Pinned miners still pay through Telegraph.** `PURSE_PIN_MINERS` routes to a
  known-good miner via `/engine/v1/ask/{miner}`; the app never calls a miner directly.
- **Burner wallets only, no schedules installed.** Setup generates a fresh
  wallet; this repo adds no cron job.

---

## Verified on Testnet

| What | Result |
|---|---|
| First Season II paid buy | 2026-11-01 18:13 UTC, BTC $77,848.80, 0.01 USDC, [tx 0xb3d0bd7c…](https://sepolia.etherscan.io/tx/0xb3d0bd7cfa2006bd504a228be96bb31bf59df53066714fed3fa50fcb535917a5) |
| On-chain settlements from the agent wallet | **36 × 0.01 USDC** to Telegraph's payment contract through Nov 14 |
| Intents bought by the agent | `CRYPTO_PRICE_USD`, `WEATHER_CHECK_TEMPERATURE`, `WEB_SEARCH_GENERAL` |
| Escrow rail (default since Nov 18) | Live ask settled in epoch 12, 367 ms, no facilitator |
| Failure handling | 8 failed-but-settled asks found, recorded as `failed_paid`, credited back to escrow (0.08 USDC) and [reported](reports/telegraph-settlement-report.md) |
| Agent | Hermes v0.22 on an Oracle Cloud ARM VM, purse as an MCP server |
| Tests | 39 offline tests + typecheck in GitHub Actions; no wallet or network needed |

---

## What it looks like
```text
> what is the BTC price in USD right now?

Hermes: Using telegraph-purse to buy the live BTC price fact.
  Purse · purse_ask

Hermes: BTC is $74,114 USD right now.
Cost $0.01 · miner Cp Coingecko (#190070) · receipt 0x1e6ea5f7e11607d3…8a089f
```
(Hermes session on Nov 9, 2026. The settlement for this exact purchase is the third row under Evidence at 2026-11-09 11:00:53.)

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

---

## Architecture

```text
Hermes agent (or any MCP client)
  │  skills/telegraph-purse/SKILL.md   policy: live facts only, a `why` for every buy
  ▼
src/index.ts      MCP server (stdio): purse_ask, purse_quote, purse_budget, ...
  ▼
src/purse.ts      quote → cap check → sign → ask → record     (serialized, fails closed)
  ├─► src/escrow.ts   escrow rail: EIP-191 signature, settled per epoch   (default)
  ├─► @x402/fetch     x402 rail: per-call on-chain settlement             (fallback)
  └─► src/ledger.ts   JSONL receipts → caps read today's spend from here
  ▼
Telegraph node  devnode.telegraphprotocol.com  →  miner  →  answer + receipt hash
  ▼
Ethereum Sepolia  test USDC settlement (tx hash, or epoch + Merkle proof)
```

### Repository Map

| Path | Purpose |
|---|---|
| `src/index.ts` | MCP server: registers the 7 tools |
| `src/purse.ts` | Core: quote, cap checks, payment, ask, verify, balance |
| `src/escrow.ts` | Escrow payment rail (sign per call, settle per epoch) |
| `src/ledger.ts` | Receipt ledger and today's-spend totals |
| `src/config.ts` | `.env` settings and defaults |
| `src/setup.ts` | `npm run setup`: build, burner wallet, test USDC, Hermes skill |
| `src/probe.ts` | `npm run probe`: free smoke test, no spend |
| `skills/telegraph-purse/SKILL.md` | Hermes skill: when to buy, when not to, how to report |
| `scripts/morning_brief.js` | Optional CLI: three live facts in one run |
| `reports/telegraph-settlement-report.md` | Settled-on-failure and chain-mismatch report for Telegraph |
| `test/` | Offline tests for caps, ledger, rails and the brief |

---

## Quick Start

Requires Node 20+.

### 1. Verify without a wallet (1 minute)

```bash
git clone https://github.com/cipoklean/telegraph-purse.git && cd telegraph-purse
npm ci
npm test        # offline: caps, ledger, rails, brief
npm run probe   # free: live intents and price quotes from the node, no spend
```

### 2. Make a paid buy with Hermes

```bash
npm run setup   # builds, makes a burner wallet in .env, mints 5 test USDC if it has Sepolia ETH,
                # installs the Hermes skill and prints the MCP entry to paste
```

No Sepolia ETH yet? Send the printed address a little from any Sepolia faucet
and run `npm run setup` again. Paste the printed `purse:` entry under
`mcp_servers:` in `~/.hermes/config.yaml`, then:

```bash
hermes mcp test purse   # expect 7 tools
```

Ask Hermes *"what's the temperature in Lagos right now?"* and check the new
`paid` row in `~/.telegraph-purse/ledger.jsonl`.

### 3. Morning Brief (optional)

Buys a crypto price, a temperature and one web search in a single run (~$0.03),
with a receipt line per leg.

```bash
npm run build
node scripts/morning_brief.js --dry-run   # show the plan; no wallet, no spend
node scripts/morning_brief.js             # buy the three facts
node scripts/morning_brief.js --help      # --symbol, --location, --query
```

A failed leg prints `FAILED` with the reason, never a made-up answer. Exit code
`0` all answered, `1` a leg failed, `2` bad arguments. Nothing is scheduled by
this repo; if you put it on a timer, set the caps first, since a scheduled run
buys with nobody watching.

---

## Settings (`.env`)
| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAPH_EVM_PRIVATE_KEY` | set by `npm run setup` | Burner wallet that pays. Never use a wallet with real funds. |
| `PURSE_MAX_PER_CALL_USD` | `0.05` | Highest price one answer may cost |
| `PURSE_DAILY_CAP_USD` | `0.50` | Most the purse spends per UTC day |
| `PURSE_ALLOWED_INTENTS` | empty (all) | Optional comma list, e.g. `CRYPTO_PRICE_USD,WEATHER_CHECK_TEMPERATURE`. When set, only those intents may be bought, and a plain `query` ask is refused: the node reveals the intent it routes to only after payment, so it cannot be checked against the list first |
| `PURSE_TIMEOUT_MS` | `60000` | Give up on an answer after this long |
| `PURSE_QUARANTINE_FAILS` | `2` | Paid failures from one miner (or auto-routed intent) that trigger a quarantine; `0` turns it off |
| `PURSE_QUARANTINE_MINUTES` | `60` | How far back failures count, and how long a quarantine lasts |
| `PURSE_PIN_MINERS` | `WEATHER_CHECK_TEMPERATURE=20260821` | `intent=minerId` pairs sent to one miner via `/engine/v1/ask/{miner}`, still paid through Telegraph. Empty = auto-route |
| `PURSE_LEDGER` | `~/.telegraph-purse/ledger.jsonl` | Where receipts are written |
| `PURSE_SCHEME` | `escrow` | Payment rail: `escrow` (sign per call, settle per epoch; no facilitator; x402 fallback), `x402` (per-call on-chain), `escrow-only` (never fall back) |
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

On the default `escrow` rail a `paid` row carries `rail: "escrow"`, `settlement: "epoch"` and an `epoch_id`, but no `tx_hash`: nothing touches the chain per call. The purchase is provable after the epoch closes at `GET /v1/blocks/{epoch_id}/deliveries/{receipt_hash}` on the node, which returns the delivery row, a Merkle proof and the block's `deliveries_root`. Escrow needs one up-front deposit (`approve` + `LedgerFacet.depositUSDC(amount)` on the Diamond the node's 402 names as `payTo`); spend is readable at `GET /v1/ledger/account/{wallet}`.

## Evidence (Season II, testnet)
Autonomous purchases by a Hermes agent through Telegraph, paid in test USDC on Ethereum Sepolia from wallet `0x51b0228bd9B8BF78CEDB11Cb485BA9F80cCf4655`.

Every row below is matched to its on-chain settlement: the wallet was funded with 5.00 test USDC on Oct 29 by an inbound transfer from a second test wallet (`0x050DE5D76AF708a7Be3FB421247f16b4CE527a28`), not by minting on this wallet. As of Nov 14 the wallet has sent **36 × 0.01 USDC transfers** to `0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b` on Sepolia: the 11 from Nov 1, the 24 from Nov 9 (weather proof, demo beats, the two Morning Brief runs, and search-miner probe tests), and one on Nov 11 that has no ledger row. Through Nov 9 the settled ledger rows (paid + failed_paid) matched the transfer count one-to-one. The wallet holds 0.64 USDC plus 0.08 credited to escrow on the payment contract — the eight `failed_paid` asks below.

| Time (UTC) | Intent | Answer | Cost | Settlement |
|---|---|---|---|---|
| 2026-11-01 18:13:44 | `CRYPTO_PRICE_USD` BTC | $77,848.80 | 0.01 USDC | [0xb3d0bd7c…17a5](https://sepolia.etherscan.io/tx/0xb3d0bd7cfa2006bd504a228be96bb31bf59df53066714fed3fa50fcb535917a5) (block 12042724) |
| 2026-11-01 18:22:47 | `CRYPTO_PRICE_USD` BTC | $77,810 | 0.01 USDC | [0x05af43d7…ebee](https://sepolia.etherscan.io/tx/0x05af43d7be0cd3fd9f6e60dde1eaa7a03afdefc88ba7744854b527290a34ebee) (block 12042769) |
| 2026-11-01 18:42:11 | `CRYPTO_PRICE_USD` BTC | n/a | 0.01 USDC | [0x1b7dcc85…dbc5a](https://sepolia.etherscan.io/tx/0x1b7dcc85d42d7617dd6a0ff0573520b2e67b5898a6bb9a3c4258f187391dbc5a) (block 12042866) |
| 2026-11-01 18:14:42 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0xd0031531…bff1](https://sepolia.etherscan.io/tx/0xd0031531978550abc63c11be7f0f7fdd7aafe33897a2f323b900fe294313bff1) (block 12042728) |
| 2026-11-01 18:15:08 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0x2d960ee6…433d](https://sepolia.etherscan.io/tx/0x2d960ee6d554e160992af2d3e7b71b21f45415f80ac81ff899159257e126433d) (block 12042730) |
| 2026-11-01 18:24:12 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0xa90f409d…0d0ba](https://sepolia.etherscan.io/tx/0xa90f409dff94395de44731547bf4428b3402165926239dd40a34887bec10d0ba) (block 12042776) |
| 2026-11-01 18:24:43 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0x99f7693b…be052](https://sepolia.etherscan.io/tx/0x99f7693bb91f182608c6d773b3208a605ba153a2c35e4df62deb36d01c8be052) (block 12042778) |
| 2026-11-01 18:42:35 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (circuit open) | 0.01 USDC `failed_paid` | [0x2cd33b6d…96703](https://sepolia.etherscan.io/tx/0x2cd33b6dc9f855df77bd1f43f3bfa060a097e6cab26c2bdae4996cbf66d96703) (block 12042868) |
| 2026-11-01 18:43:10 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0x1e707ba7…37f3](https://sepolia.etherscan.io/tx/0x1e707ba7cf56e4430da11cbc858d1efd63877e04c9bde4abdf032afbf08737f3) (block 12042871) |
| 2026-11-01 22:03:18 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0xc453c8c7…dbe25](https://sepolia.etherscan.io/tx/0xc453c8c76c6ccc8c7275855b79212e6e09303251dd20ec7a8d521936239dbe25) (block 12043867) |
| 2026-11-01 22:03:45 | `WEATHER_CHECK_TEMPERATURE` Lagos | HTTP 500 (tunnel 1033) | 0.01 USDC `failed_paid` | [0xdad34aea…f2ff1](https://sepolia.etherscan.io/tx/0xdad34aea6e9677ec7e1aec2f7f1baf00f8f90efd50f32d08696347208e6f2ff1) (block 12043869) |
| 2026-11-09 10:55:31 | `WEATHER_CHECK_TEMPERATURE` Lagos | 31.4 °C (miner 20260821) | 0.01 USDC | [0x2c15cde4…656fa](https://sepolia.etherscan.io/tx/0x2c15cde47bebcdb2740cfa35c2aef496766bc280159495932860f4ce659656fa) |
| 2026-11-09 11:00:53 | `CRYPTO_PRICE_USD` BTC | $74,114 (miner 190070) | 0.01 USDC | [0x0d4a0ce8…7624](https://sepolia.etherscan.io/tx/0x0d4a0ce8df837722dee3833f5adc14fca2aba1366cd7d25495cb4a441eae7624) |
| 2026-11-09 11:01:05 | `WEATHER_CHECK_TEMPERATURE` Lagos | 31.8 °C (miner 20260821) | 0.01 USDC | [0x88a273bd…903dbd](https://sepolia.etherscan.io/tx/0x88a273bd228f8974408bb284b9fc80e627115eae885a20d09fd9fa8bdb903dbd) |
| 2026-11-09 11:01:19 | `WEB_SEARCH_GENERAL` "AI news today" | paid; miner 303 returned no readable answer | 0.01 USDC | [0x66935deb…ec8e](https://sepolia.etherscan.io/tx/0x66935deba494a5ffe2588da3381480e697cfc307748a1f75a473e03624d0ec8e) |

The first 11 rows are the Nov 1 session (3 BTC buys paid, 8 weather asks that settled despite HTTP 500/530, recorded as `failed_paid`). Row 12 is the task-1 weather proof. Rows 13-15 are the final Morning Brief run (task 3): three live facts bought in one run under the daily budget, each with its receipt.

---

## Network

The live devnode charges in Telegraph test USDC
`0xcc194e1a843B658526D0D5C431f670028582Ae17` on **Ethereum Sepolia**
(`eip155:11155111`), not Base Sepolia as parts of the docs say (verified Nov 1,
re-verified Nov 9). `npm run setup` mints from that contract; the Anjoman faucet
also gives it out.

## Known Issue: settled on failure

On Nov 1 the auto-routed weather miner's tunnel was down (Cloudflare 1033). The
node answered HTTP 500 but still settled 0.01 USDC for each of 8 asks. Per the
[x402 docs](https://anjoman.ai/docs/using/x402-inference) a failed paid request
is credited to escrow: the wallet's `effectiveBalance` on the payment contract
held exactly 0.08 USDC on Nov 14, withdrawable. The purse still counts these as
spend (`failed_paid`), and weather is now pinned to miner 20260821 (Amanat,
Open-Meteo). Full write-up: [reports/telegraph-settlement-report.md](reports/telegraph-settlement-report.md).

---

## Who it's for and what it costs

For anyone running a personal agent that should look things up live but must
never spend without limits or leave no trail. Each fact costs about $0.01 in
test USDC; the default daily cap is $0.50, so a heavy day of lookups stays under
fifty cents. Testnet only today: MCP server, Hermes skill, caps and receipts
work end to end on a Hermes v0.22 agent.

## License

[MIT](LICENSE)
