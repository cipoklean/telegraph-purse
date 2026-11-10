import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// The Morning Brief must be safe to import: parsing and rendering are plain
// functions, and only the CLI entrypoint reaches the purse. Nothing here makes
// a request: `fetch` is replaced with a tripwire before the script is imported,
// and every leg is driven through an injected `askFn`.
// ---------------------------------------------------------------------------
const networkCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any) => {
  networkCalls.push(String(input?.url ?? input));
  throw new Error("network access is not allowed in this test");
}) as typeof fetch;

const brief = await import("../scripts/morning_brief.js");

test("importing the script makes no network call and buys nothing", () => {
  assert.deepEqual(networkCalls, [], "import must not touch the network");
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
test("defaults match the documented brief: BTC, Lagos Nigeria, AI news today", () => {
  const o = brief.parseArgs([]);
  assert.equal(o.symbol, "BTC");
  assert.equal(o.location, "Lagos, Nigeria", "the disambiguated Lagos, not plain Lagos");
  assert.equal(o.query, "AI news today");
  assert.equal(o.dryRun, false);
  assert.equal(o.help, false);
});

test("value flags override one leg each, in both space and = forms", () => {
  const spaced = brief.parseArgs(["--symbol", "ETH", "--location", "Accra, Ghana", "--query", "fintech news"]);
  assert.equal(spaced.symbol, "ETH");
  assert.equal(spaced.location, "Accra, Ghana");
  assert.equal(spaced.query, "fintech news");

  const inline = brief.parseArgs(["--symbol=SOL", "--query=markets today"]);
  assert.equal(inline.symbol, "SOL");
  assert.equal(inline.query, "markets today");
  assert.equal(inline.location, "Lagos, Nigeria", "untouched legs keep their default");
});

test("--dry-run and --help parse as booleans", () => {
  assert.equal(brief.parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(brief.parseArgs(["--help"]).help, true);
  assert.equal(brief.parseArgs(["-h"]).help, true);
});

test("a value flag without a value fails clearly", () => {
  assert.throws(() => brief.parseArgs(["--symbol"]), /--symbol needs a value/);
  assert.throws(() => brief.parseArgs(["--location", "--dry-run"]), /--location needs a value/);
  assert.throws(() => brief.parseArgs(["--query="]), /--query needs a value/);
  assert.throws(() => brief.parseArgs(["--dry-run=yes"]), /--dry-run does not take a value/);
});

test("an unknown flag or stray argument fails clearly", () => {
  assert.throws(() => brief.parseArgs(["--frobnicate"]), /unknown option --frobnicate/);
  assert.throws(() => brief.parseArgs(["-x"]), /unknown option -x/);
  assert.throws(() => brief.parseArgs(["BTC"]), /unexpected argument BTC/);
});

// ---------------------------------------------------------------------------
// The plan the CLI would buy, and the dry-run renderer
// ---------------------------------------------------------------------------
test("buildBuys carries the parsed values, a why per leg, and keeps the search miner pin", () => {
  const buys = brief.buildBuys(brief.parseArgs(["--symbol", "ETH", "--location", "Accra, Ghana", "--query", "fintech news"]));
  assert.equal(buys.length, 3);
  assert.deepEqual(buys.map((b: any) => b.intent), ["CRYPTO_PRICE_USD", "WEATHER_CHECK_TEMPERATURE", "WEB_SEARCH_GENERAL"]);
  assert.deepEqual(buys[0].params, { symbol: "ETH" });
  assert.deepEqual(buys[1].params, { location: "Accra, Ghana" });
  assert.deepEqual(buys[2].params, { query: "fintech news" });
  assert.equal(buys[2].miner, "303", "the search leg keeps its miner pin");
  for (const b of buys) assert.ok(b.why && b.why.trim().length > 0, `${b.intent} must state a why`);
});

test("the dry-run plan says plainly that no request was made and names every leg", () => {
  const plan = brief.renderPlan(brief.parseArgs([]));
  assert.match(plan, /DRY RUN: no request was made, no wallet was loaded and no USDC was spent/);
  assert.match(plan, /CRYPTO_PRICE_USD \{"symbol":"BTC"\}/);
  assert.match(plan, /WEATHER_CHECK_TEMPERATURE \{"location":"Lagos, Nigeria"\}/);
  assert.match(plan, /WEB_SEARCH_GENERAL \{"query":"AI news today"\} \(pinned to miner 303\)/);
});

// ---------------------------------------------------------------------------
// Rendering a real run: answers, receipts and failures stay truthful
// ---------------------------------------------------------------------------
const receipt = (intent: string) => ({ intent, cost_usd: 0.01, miner_id: "m1", receipt_hash: "0xreceipt", tx_hash: "0xtx" });

test("a good run renders each answer beside its receipt", async () => {
  const opts = brief.parseArgs([]);
  const { items, receipts } = await brief.runBrief(opts, async (b: any) => {
    if (b.intent === "CRYPTO_PRICE_USD") return { result: { price_usd: 74114 }, receipt: receipt(b.intent) };
    if (b.intent === "WEATHER_CHECK_TEMPERATURE") return { result: { temperature_c: 31.8 }, receipt: receipt(b.intent) };
    return { result: { answer: "something happened", sources: ["https://example.test/a"] }, receipt: receipt(b.intent) };
  });

  const out = brief.renderBrief(items, receipts, "2026-11-10");
  assert.match(out, /# ☀️ Morning Brief, 2026-11-10/);
  assert.match(out, /- BTC: \$74114/);
  assert.match(out, /- Lagos, Nigeria: 31\.8°C/);
  assert.match(out, /- Search: something happened \(1 sources; first: https:\/\/example\.test\/a\)/);
  assert.match(out, /Receipts:/);
  assert.equal(items.length, 3);
  assert.equal(receipts.length, 3);
  assert.match(out, /3 requested, 3 answered, 0 failed\./);
});

test("a failed leg is reported as FAILED with its reason, never as an answer", async () => {
  const opts = brief.parseArgs([]);
  const { items, receipts } = await brief.runBrief(opts, async (b: any) => {
    if (b.intent === "WEATHER_CHECK_TEMPERATURE") throw new Error("HTTP 500: upstream tunnel down");
    if (b.intent === "WEB_SEARCH_GENERAL") return { result: { answer: "news" }, receipt: receipt(b.intent) };
    return { result: { price_usd: 1 }, receipt: receipt(b.intent) };
  });

  assert.equal(items.length, 3, "one bad leg must not abort the other two");
  const weather = items.find((i: any) => i.intent === "WEATHER_CHECK_TEMPERATURE") as { error?: string } | undefined;
  assert.equal(weather?.error, "HTTP 500: upstream tunnel down");
  assert.equal(receipts.length, 2, "only the settled legs leave receipts");

  const out = brief.renderBrief(items, receipts, "2026-11-10");
  assert.match(out, /WEATHER_CHECK_TEMPERATURE \{"location":"Lagos, Nigeria"\}: FAILED \(HTTP 500: upstream tunnel down\)/);
  assert.match(out, /3 requested, 2 answered, 1 failed\./);
  assert.match(out, /still cost money/);
});

test("a search leg that was paid but carried no answer is called out, not dressed up", async () => {
  const opts = brief.parseArgs([]);
  const { items, receipts } = await brief.runBrief(opts, async (b: any) => {
    if (b.intent === "WEB_SEARCH_GENERAL") return { result: {}, receipt: receipt(b.intent) };
    return { result: { price_usd: 1, temperature_c: 2 }, receipt: receipt(b.intent) };
  });

  const out = brief.renderBrief(items, receipts, "2026-11-10");
  assert.match(out, /Search: paid, but the miner returned no readable answer/);
  assert.match(out, /3 requested, 3 answered, 0 failed\./, "a paid leg is answered, not failed");
});

test("a run that settled nothing says so instead of printing an empty Receipts block", () => {
  const out = brief.renderBrief([{ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, error: "ECONNREFUSED" }], [], "2026-11-10");
  assert.match(out, /Receipts: none\. Nothing settled, so nothing was recorded\./);
});

// ---------------------------------------------------------------------------
// The CLI itself, driven in-process with a stub purse
// ---------------------------------------------------------------------------
test("cli --dry-run exits 0 without touching the network", async () => {
  const before = networkCalls.length;
  const code = await brief.cli(["--dry-run"]);
  assert.equal(code, 0);
  assert.equal(networkCalls.length, before, "dry run must not reach the network");
});

test("cli --help prints the valid options and examples", async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    assert.equal(await brief.cli(["--help"]), 0);
  } finally {
    console.log = realLog;
  }
  const text = lines.join("\n");
  assert.match(text, /--symbol <SYMBOL>/);
  assert.match(text, /--location <PLACE>/);
  assert.match(text, /--query <TEXT>/);
  assert.match(text, /--dry-run/);
  assert.match(text, /--help, -h/);
  assert.match(text, /node scripts\/morning_brief\.js --symbol ETH --location "Accra, Ghana"/);
});

test("cli exits 2 and spends nothing when an argument is wrong", async () => {
  const before = networkCalls.length;
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  try {
    assert.equal(await brief.cli(["--nonsense"]), 2);
    assert.equal(await brief.cli(["--symbol"]), 2);
  } finally {
    console.error = realErr;
  }
  assert.match(errs.join("\n"), /unknown option --nonsense/);
  assert.match(errs.join("\n"), /--symbol needs a value/);
  assert.equal(networkCalls.length, before, "a bad argument must be caught before any request");
});

test.after(() => {
  globalThis.fetch = realFetch;
});
