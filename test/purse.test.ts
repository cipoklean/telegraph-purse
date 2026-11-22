import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Offline environment. Everything here is set BEFORE the modules under test are
// imported, so config.ts never needs a developer .env (DOTENV_CONFIG_PATH points
// at an empty file) and the wallet is a synthetic, non-funded key. No network
// call and no real payment endpoint is ever touched.
// ---------------------------------------------------------------------------
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "purse-test-"));
const EMPTY_ENV = path.join(SCRATCH, "empty.env");
fs.writeFileSync(EMPTY_ENV, "");

const SYNTHETIC_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

process.env.DOTENV_CONFIG_PATH = EMPTY_ENV;
process.env.TELEGRAPH_EVM_PRIVATE_KEY = SYNTHETIC_KEY;
process.env.USDC_ADDRESS = USDC;
process.env.EVM_NETWORK = "eip155:11155111";
process.env.PURSE_LEDGER = path.join(SCRATCH, "ledger.jsonl");
process.env.PURSE_MAX_PER_CALL_USD = "0.05";
process.env.PURSE_DAILY_CAP_USD = "0.5";
process.env.PURSE_TIMEOUT_MS = "1000";
process.env.PURSE_ALLOWED_INTENTS = "";
process.env.PURSE_PIN_MINERS = "";

// Tripwire: if anything here reaches the real network, that is a test bug, not a
// slow test. Replaced before the modules under test are imported so the default
// transport is the tripwire too. Restored in the final after() hook below.
const NETWORK_CALLS: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  NETWORK_CALLS.push(url);
  throw new Error(`network access during tests is not allowed: ${url}`);
});

const purse = await import("../src/purse.js");
const { config } = await import("../src/config.js");
const ledger = await import("../src/ledger.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

let ledgerSeq = 0;
function freshLedger(): string {
  const p = path.join(SCRATCH, `ledger-${++ledgerSeq}.jsonl`);
  config.ledgerPath = p;
  try { fs.unlinkSync(p); } catch { /* absent is fine */ }
  return p;
}

function setCaps(maxPerCall: number, daily: number): void {
  config.maxPerCallUsd = maxPerCall;
  config.dailyCapUsd = daily;
}

/** A real x402 v2 challenge carrying one exact-scheme requirement. */
function challenge(amountUusdc: string) {
  return {
    x402Version: 2,
    resource: { url: "https://node.test/engine/v1/ask", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: config.evmNetwork,
      amount: amountUusdc,
      asset: config.usdc,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "Telegraph Test USD", version: "1" },
    }],
  };
}

interface TransportHandlers {
  amountUusdc?: string;
  /** Response/throw for the unsigned request (the 402). */
  unpaid?: (req: Request) => Response | Promise<Response>;
  /** Response/throw for the signed request. */
  paid?: (req: Request, signal: AbortSignal) => Response | Promise<Response>;
}

function makeTransport(h: TransportHandlers): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = async (input: any, init?: any): Promise<Response> => {
    const req = new Request(input, init);
    const signed = req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("X-PAYMENT");
    calls.push(signed ? "paid" : "unpaid");
    if (!signed) {
      if (h.unpaid) return h.unpaid(req);
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": b64(challenge(h.amountUusdc ?? "50000")) },
      });
    }
    if (!h.paid) throw new Error("test transport: no paid handler configured");
    return h.paid(req, req.signal);
  };
  return { fetch: f, calls };
}

const json200 = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

async function catchErr<T>(p: Promise<T>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Seed a settled purchase straight into the ledger for today. */
function seedPaidToday(costUsd: number): void {
  ledger.record({ ts: ledger.isoNow(), status: "paid", intent: "CRYPTO_PRICE_USD", cost_usd: costUsd });
}

beforeEach(() => {
  freshLedger();
  setCaps(0.05, 0.5);
  config.timeoutMs = 1000;
  config.allowedIntents = [];
  config.scheme = "x402";
  config.quarantineFails = 0;
});

afterEach(() => {
  purse.setPaidTransport(null);
});

// Prove the tripwire held: no test in this file touched the network.
test.after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(NETWORK_CALLS, [], "tests must not reach the network");
});

// ---------------------------------------------------------------------------
// Default wiring (the seam must not replace the real wrapper by accident)
// ---------------------------------------------------------------------------
test("default paid transport is the global fetch (real x402 wrapper wiring intact)", () => {
  assert.equal(purse.paidTransport(), globalThis.fetch);
});

// ---------------------------------------------------------------------------
// Section 2: accounting
// ---------------------------------------------------------------------------
test("valid paid response records a paid receipt and returns the answer", async () => {
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => json200({ result: "42", routing: { miner: "m1" }, cost_usd: 0.05, miner_id: "m1", miner_name: "miner one", duration_ms: 7, signal_hash: "0xsig" }),
  });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "need the live BTC price" });

  assert.equal(out.result, "42");
  assert.equal(out.receipt.status, "paid");
  assert.equal(out.receipt.cost_usd, 0.05);
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "paid");
  assert.equal(ledger.spentTodayUsd(), 0.05);
  assert.deepEqual(t.calls, ["unpaid", "paid"]);
});

test("malformed 200 JSON after signing records failed_paid and throws PaidFailureError", async () => {
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => json200("not-json{", { "content-type": "text/plain" }),
  });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "live price" }));

  assert.ok(err instanceof purse.PaidFailureError, `expected PaidFailureError, got ${err.name}: ${err.message}`);
  assert.ok(!(err instanceof SyntaxError), "must not leak a raw JSON syntax error");
  assert.match(err.message, /0\.05/);
  assert.match(err.message, /not established|unknown/i);

  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed_paid");
  assert.equal(rows[0].cost_usd, 0.05);
  assert.equal(ledger.spentTodayUsd(), 0.05, "a signed purchase must still count toward daily spend");
});

test("HTTP 5xx after signing with a PAYMENT-RESPONSE header records failed_paid with the settlement tx", async () => {
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => new Response("miner upstream exploded", {
      status: 502,
      headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xdeadbeef" }) },
    }),
  });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "live price" }));

  assert.ok(err instanceof purse.PaidFailureError, `expected PaidFailureError, got ${err.name}: ${err.message}`);
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed_paid");
  assert.equal(rows[0].cost_usd, 0.05);
  assert.equal(rows[0].tx_hash, "0xdeadbeef");
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

test("response body read failure after signing is recorded as failed_paid, not a raw error", async () => {
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => new Response(
      new ReadableStream({ start(c) { c.error(new Error("body stream failed")); } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "live price" }));

  assert.ok(err instanceof purse.PaidFailureError, `expected PaidFailureError, got ${err.name}: ${err.message}`);
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed_paid");
  assert.equal(rows[0].cost_usd, 0.05);
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

test("pre-signing network failure is recorded as failed with no cost", async () => {
  const t = makeTransport({
    unpaid: () => { throw new Error("ECONNREFUSED 127.0.0.1"); },
  });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "live price" }));

  assert.ok(!(err instanceof purse.PaidFailureError), "nothing was signed, so this is not a paid failure");
  assert.ok(!(err instanceof purse.BudgetError), "a network failure is not a budget block");
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].cost_usd, undefined);
  assert.equal(ledger.spentTodayUsd(), 0);
  assert.deepEqual(t.calls, ["unpaid"]);
});

test("post-signing timeout records the signed amount as failed_paid and never calls it free", async () => {
  config.timeoutMs = 30;
  const t = makeTransport({
    amountUusdc: "50000",
    paid: (_req, signal) => new Promise<Response>((_res, rej) => {
      signal.addEventListener("abort", () =>
        rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    }),
  });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "live price" }));

  assert.ok(err instanceof purse.PaidFailureError, `expected PaidFailureError, got ${err.name}: ${err.message}`);
  assert.match(err.message, /0\.05/);
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed_paid");
  assert.equal(rows[0].cost_usd, 0.05);
  assert.equal(rows[0].tx_hash, undefined, "no settlement proof, so no tx is claimed");
  assert.equal(ledger.spentTodayUsd(), 0.05);
  assert.deepEqual(t.calls, ["unpaid", "paid"]);
});

// ---------------------------------------------------------------------------
// Section 3: concurrency
// ---------------------------------------------------------------------------
test("concurrent asks never overspend one purchase's remaining daily budget", async () => {
  setCaps(0.05, 0.05); // room for exactly one 0.05 purchase today
  const t = makeTransport({
    amountUusdc: "50000",
    paid: async () => {
      // Hold the signed response long enough that both asks would clear their guard
      // before either records a spend, which is what leaks without serialization.
      await new Promise((r) => setTimeout(r, 60));
      return json200({ result: "ok", cost_usd: 0.05 });
    },
  });
  purse.setPaidTransport(t.fetch);

  const results = await Promise.allSettled([
    purse.ask({ intent: "CRYPTO_PRICE_USD", why: "first ask" }),
    purse.ask({ intent: "CRYPTO_PRICE_USD", why: "second ask" }),
  ]);

  const paid = results.filter((r) => r.status === "fulfilled");
  const blocked = results.filter((r) => r.status === "rejected" && (r).reason instanceof purse.BudgetError);
  assert.equal(paid.length, 1, "exactly one purchase should be allowed in the budget");
  assert.equal(blocked.length, 1, "the other ask must be refused by the daily cap");

  const rows = ledger.readAll().filter((r) => r.status === "paid" || r.status === "failed_paid");
  assert.equal(rows.length, 1);
  assert.equal(ledger.spentTodayUsd(), 0.05);
  assert.ok(ledger.spentTodayUsd() <= config.dailyCapUsd, "spend must not exceed the daily cap");
  const receipt = (paid[0] as PromiseFulfilledResult<any>).value.receipt;
  assert.equal(receipt.status, "paid");
  assert.equal(receipt.cost_usd, 0.05, "the paid receipt must not be contaminated by the blocked ask");
});

test("an earlier queued ask failing does not poison a later one", async () => {
  let n = 0;
  const t = makeTransport({
    amountUusdc: "50000",
    unpaid: () => {
      n++;
      if (n === 1) throw new Error("ECONNRESET on the first ask");
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(challenge("50000")) } });
    },
    paid: () => json200({ result: "second-ok", cost_usd: 0.05 }),
  });
  purse.setPaidTransport(t.fetch);

  const first = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "first" }));
  assert.ok(!(first instanceof purse.PaidFailureError));

  const second: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", why: "second" });
  assert.equal(second.result, "second-ok");
  assert.equal(second.receipt.status, "paid");
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

test("per-call refusal blocks before signing and never lets a signature leave", async () => {
  setCaps(0.05, 0.5);
  const t = makeTransport({ amountUusdc: "60000" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "pricier than the cap" }));

  assert.ok(err instanceof purse.BudgetError, `expected BudgetError, got ${err.name}: ${err.message}`);
  assert.equal(t.calls.includes("paid"), false, "no signed request may be sent");
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(ledger.spentTodayUsd(), 0);
});

test("daily-cap refusal blocks before signing", async () => {
  setCaps(0.05, 0.05);
  seedPaidToday(0.05); // budget already exhausted today
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "budget is gone" }));

  assert.ok(err instanceof purse.BudgetError, `expected BudgetError, got ${err.name}: ${err.message}`);
  assert.match(err.message, /remaining budget/);
  assert.equal(t.calls.includes("paid"), false, "no signed request may be sent");
  const rows = ledger.readAll();
  assert.equal(rows[rows.length - 1].status, "blocked");
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

// ---------------------------------------------------------------------------
// Section 4: policy and configuration
// ---------------------------------------------------------------------------
test("a purchase without a why is refused before signing", async () => {
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD" } as any));

  assert.ok(err instanceof purse.PolicyError, `expected PolicyError, got ${err.name}: ${err.message}`);
  assert.deepEqual(t.calls, [], "nothing may be sent when the why is missing");
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(ledger.spentTodayUsd(), 0);
});

test("a whitespace-only why is refused before signing", async () => {
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "   \t " }));

  assert.ok(err instanceof purse.PolicyError, `expected PolicyError, got ${err.name}: ${err.message}`);
  assert.deepEqual(t.calls, []);
  assert.equal(ledger.readAll()[0].status, "blocked");
  assert.equal(ledger.spentTodayUsd(), 0);
});

test("an allow-list refuses a query-only ask before anything is sent", async () => {
  config.allowedIntents = ["CRYPTO_PRICE_USD"];
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ query: "what is the bitcoin price right now?", why: "need the live BTC price" }));

  assert.ok(err instanceof purse.BudgetError, `expected BudgetError, got ${err.name}: ${err.message}`);
  assert.match(err.message, /PURSE_ALLOWED_INTENTS/);
  assert.deepEqual(t.calls, [], "nothing may be sent, not even the unpaid challenge probe");
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(rows[0].query, "what is the bitcoin price right now?");
  assert.equal(ledger.spentTodayUsd(), 0);
});

test("an allow-list still allows the canonical intent it names", async () => {
  config.allowedIntents = ["CRYPTO_PRICE_USD"];
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => json200({ result: "ok", cost_usd: 0.05, miner_id: "m1" }),
  });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "live price" });

  assert.equal(out.result, "ok");
  assert.equal(out.receipt.status, "paid");
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

test("quote reports per-call and daily cap booleans plus local spending", async () => {
  setCaps(0.05, 0.5);
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const q: any = await purse.quote({ intent: "CRYPTO_PRICE_USD" });

  assert.equal(q.status, 402);
  assert.equal(q.within_per_call_cap, true);
  assert.equal(q.within_daily_cap, true);
  assert.equal(q.within_caps, true);
  assert.equal(q.spent_today_usd, 0);
  assert.equal(q.remaining_daily_usd, 0.5);
  assert.equal(q.accepts[0].usd, 0.05);
});

test("quote flags a price under the per-call cap but over the remaining daily budget", async () => {
  setCaps(0.05, 0.05);
  seedPaidToday(0.05); // daily budget fully spent
  const t = makeTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);

  const q: any = await purse.quote({ intent: "CRYPTO_PRICE_USD" });

  assert.equal(q.within_per_call_cap, true, "0.05 is at the per-call cap");
  assert.equal(q.within_daily_cap, false, "nothing remains in today's budget");
  assert.equal(q.within_caps, false, "the combined boolean must reflect the daily cap");
  assert.equal(q.spent_today_usd, 0.05);
  assert.equal(q.remaining_daily_usd, 0);
});

// ---------------------------------------------------------------------------
// Escrow rail
// ---------------------------------------------------------------------------

const ESCROW_TEMPLATE = (amt: string) =>
  `Telegraph Escrow Payment\n\nWallet: {from}\nPay To: ${PAY_TO}\nNetwork: eip155:11155111\nAmount: ${amt} uUSDC\nResource: /v1/ask\nNonce: {nonce}\nValid After: {validAfter}\nValid Before: {validBefore}`;

function escrowChallenge(amountUusdc = "50000") {
  return {
    error: "payment required",
    accepts: [{
      scheme: "escrow", network: config.evmNetwork, payTo: PAY_TO, price: "$0.05",
      extra: { message: ESCROW_TEMPLATE(amountUusdc), resource: "/v1/ask", signWith: "personal_sign (EIP-191)" },
    }],
  };
}

function escrowTransport(h: TransportHandlers): { fetch: typeof fetch; calls: string[]; payments: any[] } {
  const calls: string[] = [];
  const payments: any[] = [];
  const f = async (input: any, init?: any): Promise<Response> => {
    const req = new Request(input, init);
    const xp = req.headers.get("X-PAYMENT");
    if (!xp) {
      calls.push("unpaid");
      return new Response(JSON.stringify(escrowChallenge(h.amountUusdc)), { status: 402, headers: { "content-type": "application/json" } });
    }
    calls.push("paid");
    payments.push(JSON.parse(Buffer.from(xp, "base64").toString("utf8")));
    if (!h.paid) throw new Error("test transport: no paid handler configured");
    return h.paid(req, req.signal);
  };
  return { fetch: f, calls, payments };
}

test("escrow rail signs X-PAYMENT and records rail=escrow receipt", async () => {
  config.scheme = "escrow";
  const receipt = { receipt_hash: "0xrcpt", rail: "escrow", payer: "0xabc", miner: "302", intent: "CRYPTO_PRICE_USD", amount_uusdc: "50000", epoch_id: 2107, settlement: "epoch", chain: "telegraph" };
  const t = escrowTransport({
    amountUusdc: "50000",
    paid: () => json200(
      { result: "74000", miner_id: "302", miner_name: "miner", cost_usd: 0.05, duration_ms: 9, signal_hash: "0xsig" },
      { "X-PAYMENT-RESPONSE": b64(receipt) },
    ),
  });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "live price via escrow" });

  assert.deepEqual(t.calls, ["unpaid", "paid"]);
  const pay = t.payments[0];
  assert.equal(pay.scheme, "escrow");
  assert.equal(pay.x402Version, 2);
  assert.ok(pay.payload.signature.startsWith("0x"), "an EIP-191 signature must be present");
  assert.equal(pay.payload.authorization.value, "50000");
  assert.equal(pay.payload.authorization.to, PAY_TO);
  assert.equal(out.receipt.status, "paid");
  assert.equal(out.receipt.rail, "escrow");
  assert.equal(out.receipt.settlement, "epoch");
  assert.equal(out.receipt.epoch_id, 2107);
  assert.equal(out.receipt.receipt_hash, "0xrcpt");
});

test("escrow guard blocks before anything is signed", async () => {
  config.scheme = "escrow";
  const t = escrowTransport({ amountUusdc: "500000" }); // $0.50, over the $0.05 per-call cap
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", why: "over-cap probe" }));

  assert.ok(err instanceof purse.BudgetError, `expected BudgetError, got ${err.name}`);
  assert.match(err.message, /per-call cap/);
  assert.deepEqual(t.calls, ["unpaid"], "the signed retry must never leave");
  const rows = ledger.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
});

test("escrow default falls back to x402 when the node offers no escrow entry", async () => {
  config.scheme = "escrow";
  const t = makeTransport({
    amountUusdc: "50000",
    paid: () => json200({ result: "1", cost_usd: 0.05, miner_id: "m1", duration_ms: 5 }),
  });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "fallback check" });

  assert.equal(out.receipt.status, "paid");
  // unpaid challenge read by the escrow wrapper, then the x402 wrapper's own challenge + paid retry
  assert.deepEqual(t.calls, ["unpaid", "unpaid", "paid"]);
});

test("escrow rail refuses a zero price: nothing is signed, nothing is spend", async () => {
  config.scheme = "escrow";
  const t = escrowTransport({ amountUusdc: "0" });
  purse.setPaidTransport(t.fetch);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "zero-price probe" }));

  assert.ok(err instanceof purse.BudgetError, `expected BudgetError, got ${err.name}: ${err.message}`);
  assert.deepEqual(t.calls, ["unpaid"], "no signed retry may leave the wallet");
  assert.equal(ledger.readAll()[0].status, "blocked");
});

test("an x402 challenge with no amount never gets a signed retry", async () => {
  const t = makeTransport({
    unpaid: () => new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        resource: { url: "https://node.test/engine/v1/ask", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: config.evmNetwork, asset: config.usdc, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
      }) },
    }),
  });
  purse.setPaidTransport(t.fetch);

  await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "unpriced challenge probe" }));

  assert.deepEqual(t.calls, ["unpaid"], "an unreadable price must fail closed");
  const row = ledger.readAll()[0];
  assert.ok(row.status === "blocked" || row.status === "failed", `expected blocked or failed, got ${row.status}`);
});

test("a signing failure after guard approval is 'failed', never a spend", async () => {
  config.scheme = "escrow";
  const savedKey = config.privateKey;
  config.privateKey = ""; // account() throws inside the wrapper, after checkSpend approved the price
  const t = escrowTransport({ amountUusdc: "50000" });
  purse.setPaidTransport(t.fetch);
  try {
    const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "unconfigured wallet probe" }));
    assert.ok(!(err instanceof purse.PaidFailureError), `nothing was signed, so PaidFailureError is wrong: ${err.message}`);
    const row = ledger.readAll()[0];
    assert.equal(row.status, "failed", `expected failed, got ${row.status}: ${row.reason}`);
    assert.equal(row.cost_usd, undefined);
    assert.deepEqual(t.calls, ["unpaid"]);
  } finally {
    config.privateKey = savedKey;
  }
});

test("a paid row with no node cost still charges the signed price", async () => {
  config.scheme = "escrow";
  const receipt = { receipt_hash: "0xr", rail: "escrow", epoch_id: 1, settlement: "epoch" }; // no amount_uusdc
  const t = escrowTransport({
    amountUusdc: "50000",
    paid: () => json200({ result: "1", miner_id: "m" }, { "X-PAYMENT-RESPONSE": b64(receipt) }), // no cost_usd either
  });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "cost fallback check" });

  assert.equal(out.receipt.status, "paid");
  assert.equal(out.receipt.cost_usd, 0.05, "the signed price is the last cost fallback");
  assert.equal(ledger.spentTodayUsd(), 0.05);
});

test("an escrow template with an unfilled placeholder is never signed", async () => {
  config.scheme = "escrow";
  const base = escrowChallenge("50000");
  const bad = { ...base, accepts: [{ ...base.accepts[0], extra: { ...base.accepts[0].extra, message: ESCROW_TEMPLATE("50000") + "\nDeadline: {deadline}" } }] };
  const calls: string[] = [];
  const t = async (input: any, init?: any): Promise<Response> => {
    const req = new Request(input, init);
    calls.push(req.headers.has("X-PAYMENT") ? "paid" : "unpaid");
    return new Response(JSON.stringify(bad), { status: 402, headers: { "content-type": "application/json" } });
  };
  purse.setPaidTransport(t);

  const err = await catchErr(purse.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" }, why: "template probe" }));

  assert.match(err.message, /placeholder/i);
  assert.deepEqual(calls, ["unpaid"], "the template must be rejected before signing");
  assert.equal(ledger.readAll()[0].status, "failed", "nothing was signed, so nothing counts as spend");
});

test("a corrupt ledger line is skipped, not fatal", () => {
  fs.appendFileSync(config.ledgerPath, JSON.stringify({ ts: ledger.isoNow(), status: "paid", intent: "X", cost_usd: 0.01 }) + "\n");
  fs.appendFileSync(config.ledgerPath, '{"ts":"broken');
  fs.appendFileSync(config.ledgerPath, "\n" + JSON.stringify({ ts: ledger.isoNow(), status: "paid", intent: "Y", cost_usd: 0.02 }) + "\n");
  assert.equal(ledger.readAll().length, 2);
  assert.equal(ledger.spentTodayUsd(), 0.03);
});

// ---------------------------------------------------------------------------
// Miner quarantine: repeated paid failures stop the bleed before the daily cap
// ---------------------------------------------------------------------------
const failing502 = () => new Response(JSON.stringify({ error: "upstream down", miner_id: "bad-miner" }), { status: 502 });

test("two paid failures from a pinned miner quarantine it before anything is signed", async () => {
  config.quarantineFails = 2; config.quarantineMinutes = 60;
  const t = makeTransport({ amountUusdc: "10000", paid: failing502 });
  purse.setPaidTransport(t.fetch);
  const ask = () => purse.ask({ intent: "WEATHER_CHECK_TEMPERATURE", params: { location: "Lagos" }, miner: "bad-miner", why: "weather now" });

  assert.ok((await catchErr(ask())) instanceof purse.PaidFailureError);
  assert.ok((await catchErr(ask())) instanceof purse.PaidFailureError);
  const callsBefore = t.calls.length;
  const err = await catchErr(ask());

  assert.ok(err instanceof purse.QuarantineError, `expected QuarantineError, got ${err.name}: ${err.message}`);
  assert.match(err.message, /miner bad-miner .*quarantined until \d\d:\d\d UTC/);
  assert.equal(t.calls.length, callsBefore, "a quarantined miner must not even be asked for a price");
  const rows = ledger.readAll();
  assert.deepEqual(rows.map((r) => r.status), ["failed_paid", "failed_paid", "blocked"]);
  assert.equal(ledger.spentTodayUsd(), 0.02, "the third ask cost nothing");
});

test("quarantined auto-route still allows an ask that names a different miner", async () => {
  config.quarantineFails = 2; config.quarantineMinutes = 60;
  const fail = makeTransport({ amountUusdc: "10000", paid: failing502 });
  purse.setPaidTransport(fail.fetch);
  const auto = () => purse.ask({ intent: "WEATHER_CHECK_TEMPERATURE", params: { location: "Lagos" }, why: "weather now" });
  await catchErr(auto()); await catchErr(auto());
  assert.equal(ledger.readAll()[0].miner_id, "bad-miner", "the failing miner named in the error body is kept");

  assert.ok((await catchErr(auto())) instanceof purse.QuarantineError);

  const ok = makeTransport({ amountUusdc: "10000", paid: () => json200({ result: "28.7", cost_usd: 0.01, miner_id: "good" }) });
  purse.setPaidTransport(ok.fetch);
  const out: any = await purse.ask({ intent: "WEATHER_CHECK_TEMPERATURE", params: { location: "Lagos" }, miner: "good", why: "weather now" });
  assert.equal(out.result, "28.7");
});

test("settlement-layer failures never feed the quarantine count", async () => {
  config.quarantineFails = 2; config.quarantineMinutes = 60;
  // The Nov 18 facilitator outage produced three of these; none is the miner's fault.
  for (let i = 0; i < 2; i++) ledger.record({
    ts: ledger.isoNow(), status: "failed_paid", intent: "WEB_SEARCH_GENERAL", pinned: false, cost_usd: 0.01,
    reason: '$0.01 was paid but no answer came back. HTTP 402: settlement failed: Post "https://facilitator.x402.rs/settle": context deadline exceeded',
  });
  const t = makeTransport({ amountUusdc: "10000", paid: () => json200({ result: "ok", cost_usd: 0.01, miner_id: "m1" }) });
  purse.setPaidTransport(t.fetch);

  const out: any = await purse.ask({ intent: "WEB_SEARCH_GENERAL", params: { query: "news" }, why: "auto-route must survive a facilitator outage" });
  assert.equal(out.receipt.status, "paid");
});

test("rows written before the pinned field count for neither quarantine target", () => {
  const now = ledger.isoNow();
  ledger.record({ ts: now, status: "failed_paid", intent: "X", miner_id: "m", cost_usd: 0.01 });
  ledger.record({ ts: now, status: "failed_paid", intent: "X", miner_id: "m", cost_usd: 0.01 });
  assert.equal(ledger.recentPaidFailures({ intent: "X" }, 3600_000).length, 0, "legacy rows never quarantine the auto-route");
  assert.equal(ledger.recentPaidFailures({ miner: "m" }, 3600_000).length, 2, "they still count against the named miner");
});

test("old paid failures fall out of the window and quarantine can be turned off", () => {
  const old = new Date(Date.now() - 2 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  ledger.record({ ts: old, status: "failed_paid", intent: "X", miner_id: "m", pinned: true, cost_usd: 0.01 });
  ledger.record({ ts: old, status: "failed_paid", intent: "X", miner_id: "m", pinned: true, cost_usd: 0.01 });
  assert.equal(ledger.recentPaidFailures({ miner: "m" }, 3600_000).length, 0);
  assert.equal(ledger.recentPaidFailures({ miner: "m" }, 3 * 3600_000).length, 2);
  assert.equal(ledger.recentPaidFailures({ intent: "X" }, 3 * 3600_000).length, 0, "pinned failures never quarantine the auto-route");
});
