#!/usr/bin/env node
/**
 * Morning Brief — daily agent routine.
 * Buys three live facts through the purse under the daily budget (BTC price,
 * Lagos temperature, one fresh web search) and prints one composed message
 * with a receipt line per purchase.
 *
 * Run:  npm run build && node scripts/morning_brief.js
 */
import { ask } from "../dist/purse.js";

const brief = {
  title: "☀️ Morning Brief",
  date: new Date().toISOString().slice(0, 10),
  items: [],
  receipts: [],
};

const buys = [
  { intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" },
    why: "Morning Brief: live BTC price is a changing fact outside training data." },
  { intent: "WEATHER_CHECK_TEMPERATURE", params: { location: "Lagos" },
    why: "Morning Brief: current Lagos temperature is a changing fact outside training data." },
  { intent: "WEB_SEARCH_GENERAL", params: { query: "AI news today" }, miner: "303",
    why: "Morning Brief: a fresh web search for today's news (pinned to ChainSight)." },
];

for (const b of buys) {
  try {
    const res = await ask(b);
    brief.items.push({ intent: b.intent, params: b.params, result: res.result });
    brief.receipts.push(res.receipt);
  } catch (e) {
    brief.items.push({ intent: b.intent, params: b.params, error: String(e.message || e) });
  }
}

// Compose printable brief
const lines = [`# ${brief.title} — ${brief.date}`];
for (const it of brief.items) {
  if (it.error) { lines.push(`- ${it.intent} ${JSON.stringify(it.params)}: FAILED (${it.error})`); continue; }
  if (it.intent === "CRYPTO_PRICE_USD") {
    const p = it.result?.price_usd ?? it.result?.price ?? JSON.stringify(it.result);
    lines.push(`- BTC: $${p}`);
  } else if (it.intent === "WEATHER_CHECK_TEMPERATURE") {
    lines.push(`- Lagos: ${it.result?.temperature_c ?? "?"}°C`);
  } else if (it.intent === "WEB_SEARCH_GENERAL") {
    const a = it.result?.answer;
    const src = it.result?.sources;
    if (a) lines.push(`- Search: ${a}${Array.isArray(src) && src.length ? ` (${src.length} sources; first: ${src[0]})` : ""}`);
    else lines.push(`- Search: ${JSON.stringify(it.result).slice(0, 220)}`);
  } else {
    lines.push(`- ${it.intent}: ${JSON.stringify(it.result)}`);
  }
}
lines.push("");
lines.push("Receipts:");
for (const r of brief.receipts) {
  lines.push(`- ${r.intent} · ${r.cost_usd} USDC · miner ${r.miner_id} · receipt ${(r.receipt_hash || "").slice(0, 18)}… · tx ${(r.tx_hash || "").slice(0, 18)}…`);
}
console.log(lines.join("\n"));
