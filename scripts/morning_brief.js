#!/usr/bin/env node
/**
 * Morning Brief: a daily agent routine.
 *
 * Buys three live facts through the purse under the daily budget (a crypto
 * price, a current temperature, one fresh web search) and prints one composed
 * message with a receipt line per purchase.
 *
 * Calling this file as a CLI runs the purchases. Importing it does not: the
 * parsing, planning and rendering below are plain functions, and the purse is
 * only loaded inside `runBrief`, after the CLI entrypoint has decided to spend.
 *
 *   node scripts/morning_brief.js                     # buy the three default facts
 *   node scripts/morning_brief.js --dry-run           # show the plan, buy nothing
 *   node scripts/morning_brief.js --symbol ETH --location "Accra, Ghana"
 *   node scripts/morning_brief.js --help
 *
 * Needs a build first (`npm run build`), because the purse lives in dist/.
 */
import { pathToFileURL } from "node:url";

/** Documented defaults. Lagos carries the country because plain "Lagos" also matches Lagos, Portugal. */
export const DEFAULTS = { symbol: "BTC", location: "Lagos, Nigeria", query: "AI news today" };

/**
 * The search leg is pinned to one miner: on 2026-11-09 most search miners
 * returned thin or off-topic answers, and miner 303 (ChainSight) was the known
 * working one. This is a pin, not a price or a guarantee of an answer.
 */
export const SEARCH_MINER = "303";

export const USAGE = `Morning Brief: buy three live facts through the Telegraph purse.

Usage:
  node scripts/morning_brief.js [options]

Options:
  --symbol <SYMBOL>      Crypto symbol for the CRYPTO_PRICE_USD leg (default: ${DEFAULTS.symbol})
  --location <PLACE>     Place for the WEATHER_CHECK_TEMPERATURE leg (default: ${DEFAULTS.location})
  --query <TEXT>         Query for the WEB_SEARCH_GENERAL leg (default: ${DEFAULTS.query})
  --dry-run              Print the intents and params that would be bought, then exit.
                         No request is made, no wallet is loaded and nothing is spent.
  --help, -h             Show this help and exit.
  --flag=value           Any value flag also accepts the = form.

Examples:
  node scripts/morning_brief.js
  node scripts/morning_brief.js --dry-run
  node scripts/morning_brief.js --symbol ETH --location "Accra, Ghana"
  node scripts/morning_brief.js --query "Nigerian fintech news today"

Every leg costs about $0.01 USDC in test USDC on Ethereum Sepolia and is subject
to PURSE_MAX_PER_CALL_USD and PURSE_DAILY_CAP_USD. Exits 1 if any leg failed.
`;

const VALUE_FLAGS = { "--symbol": "symbol", "--location": "location", "--query": "query" };
const BOOL_FLAGS = { "--dry-run": "dryRun", "--help": "help", "-h": "help" };

/**
 * Parse CLI arguments into options. Throws on an unknown flag, a non-flag
 * argument, or a value flag given without a value, so the CLI can fail clearly
 * before any request is made.
 */
export function parseArgs(args) {
  const opts = { ...DEFAULTS, dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;

    if (name in BOOL_FLAGS) {
      if (inline !== undefined) throw new Error(`${name} does not take a value`);
      opts[BOOL_FLAGS[name]] = true;
      continue;
    }
    if (name in VALUE_FLAGS) {
      const value = inline !== undefined ? inline : args[++i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`${name} needs a value, for example ${name} ${DEFAULTS[VALUE_FLAGS[name]]}`);
      }
      opts[VALUE_FLAGS[name]] = value;
      continue;
    }
    throw new Error(raw.startsWith("-")
      ? `unknown option ${raw}. Run with --help to see the valid options.`
      : `unexpected argument ${raw}. Run with --help to see the valid options.`);
  }
  return opts;
}

/** The three intents this brief buys, with the one-line why each paid ask requires. */
export function buildBuys(opts) {
  return [
    { intent: "CRYPTO_PRICE_USD", params: { symbol: opts.symbol },
      why: `Morning Brief: live ${opts.symbol} price is a changing fact outside training data.` },
    { intent: "WEATHER_CHECK_TEMPERATURE", params: { location: opts.location },
      why: `Morning Brief: current temperature in ${opts.location} is a changing fact outside training data.` },
    { intent: "WEB_SEARCH_GENERAL", params: { query: opts.query }, miner: SEARCH_MINER,
      why: "Morning Brief: a fresh web search for today's news (pinned to ChainSight, miner 303)." },
  ];
}

/** What the brief would ask for, printed when nothing may be spent. */
export function renderPlan(opts, buys = buildBuys(opts)) {
  const lines = [`# Morning Brief plan, ${new Date().toISOString().slice(0, 10)}`, ""];
  lines.push("DRY RUN: no request was made, no wallet was loaded and no USDC was spent.");
  lines.push("The price of each leg is only known from the node's 402 challenge, so no quote is shown here.");
  lines.push("");
  for (const b of buys) {
    lines.push(`- ${b.intent} ${JSON.stringify(b.params)}${b.miner ? ` (pinned to miner ${b.miner})` : " (auto-routed)"}`);
    lines.push(`  why: ${b.why}`);
  }
  return lines.join("\n");
}

/**
 * Render the brief from the collected items. Failures are printed with their
 * reason and never dressed up as an answer.
 */
export function renderBrief(items, receipts, date = new Date().toISOString().slice(0, 10)) {
  const lines = [`# ☀️ Morning Brief, ${date}`];
  const failed = [];

  for (const it of items) {
    const label = it.params ? JSON.stringify(it.params) : "";
    if (it.error) {
      lines.push(`- ${it.intent} ${label}: FAILED (${it.error})`);
      failed.push(it.intent);
      continue;
    }
    if (it.intent === "CRYPTO_PRICE_USD") {
      const p = it.result?.price_usd ?? it.result?.price;
      lines.push(p === undefined
        ? `- ${it.symbol ?? "price"}: paid, but no price field came back: ${JSON.stringify(it.result).slice(0, 220)}`
        : `- ${it.symbol ?? "price"}: $${p}`);
    } else if (it.intent === "WEATHER_CHECK_TEMPERATURE") {
      const t = it.result?.temperature_c ?? it.result?.temperature;
      lines.push(t === undefined
        ? `- ${it.location ?? "weather"}: paid, but no temperature field came back: ${JSON.stringify(it.result).slice(0, 220)}`
        : `- ${it.location ?? "weather"}: ${t}°C`);
    } else if (it.intent === "WEB_SEARCH_GENERAL") {
      const a = it.result?.answer;
      const src = it.result?.sources;
      if (a) lines.push(`- Search: ${a}${Array.isArray(src) && src.length ? ` (${src.length} sources; first: ${src[0]})` : ""}`);
      else lines.push(`- Search: paid, but the miner returned no readable answer: ${JSON.stringify(it.result).slice(0, 220)}`);
    } else {
      lines.push(`- ${it.intent}: ${JSON.stringify(it.result)}`);
    }
  }

  lines.push("");
  if (receipts.length) {
    lines.push("Receipts:");
    for (const r of receipts) {
      lines.push(`- ${r.intent} · ${r.cost_usd} USDC · miner ${r.miner_id} · receipt ${(r.receipt_hash || "").slice(0, 18)}… · tx ${(r.tx_hash || "").slice(0, 18)}…`);
    }
  } else {
    lines.push("Receipts: none. Nothing settled, so nothing was recorded.");
  }
  lines.push("");
  lines.push(`${items.length} requested, ${items.length - failed.length} answered, ${failed.length} failed.`);
  if (failed.length) lines.push(`Failed: ${failed.join(", ")} (see the reasons above; a paid leg that failed still cost money).`);
  return lines.join("\n");
}

/**
 * Run the three legs in order and collect results, receipts and errors.
 * `askFn` is injected so the rendering path can be tested with no request.
 */
export async function runBrief(opts, askFn) {
  const items = [];
  const receipts = [];
  for (const b of buildBuys(opts)) {
    try {
      const res = await askFn(b);
      const item = { intent: b.intent, params: b.params, result: res.result };
      if (b.intent === "CRYPTO_PRICE_USD") item.symbol = opts.symbol;
      if (b.intent === "WEATHER_CHECK_TEMPERATURE") item.location = opts.location;
      items.push(item);
      if (res.receipt) receipts.push(res.receipt);
    } catch (e) {
      items.push({ intent: b.intent, params: b.params, error: String(e?.message || e) });
    }
  }
  return { items, receipts };
}

/**
 * The CLI itself. Returns the process exit code so tests can drive every path
 * in-process: 0 bought as planned, 1 a leg failed, 2 the arguments were wrong.
 */
export async function cli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`morning_brief: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.dryRun) {
    console.log(renderPlan(opts));
    return 0;
  }

  // Only now, on a real run, is the purse loaded and the wallet touched.
  const { ask } = await import("../dist/purse.js");
  const { items, receipts } = await runBrief(opts, ask);
  console.log(renderBrief(items, receipts));
  return items.some((it) => it.error) ? 1 : 0;
}

// Run only when this file is the CLI entrypoint, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
