import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithEscrow } from "./escrow.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { sepolia } from "viem/chains";
import { config } from "./config.js";
import { record, spentTodayUsd, Entry, isoNow } from "./ledger.js";

const b64json = (v: string | null) => {
  if (!v) return undefined;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { return undefined; }
};

export class BudgetError extends Error {}
export class PaidFailureError extends Error {}
export class PolicyError extends Error {}

export function account() {
  if (!config.privateKey) throw new Error("TELEGRAPH_EVM_PRIVATE_KEY is not set");
  return privateKeyToAccount(config.privateKey as `0x${string}`);
}

/**
 * Raw HTTP transport beneath the x402 payment wrapper. Production uses the global fetch.
 * Tests replace it to drive the REAL price guard and REAL EIP-3009 signing against a
 * scripted offline endpoint, so no network call and no wallet spend is involved.
 */
let transport: typeof fetch = fetch;
let paidFetch: typeof fetch | null = null;
let escrowFetch: typeof fetch | null = null;
let lastBlock: string | null = null;
/**
 * Price of the payment signed for the current ask, if any.
 *
 * Read through this accessor rather than the variable itself: the x402 client
 * writes the variable from a callback in another module, and control-flow
 * analysis cannot see that write, so it would narrow a post-assignment read of
 * the variable to `never`. A declared return type keeps the read honest.
 */
let signedUsd: number | null = null;
function signedUsdNow(): number | null { return signedUsd; }

/**
 * Paid asks share module state (the signed price, the guard's block reason and the cached
 * wrapper), so only one may be in flight at a time: two at once would both clear the same
 * daily-budget guard before either recorded a spend. A chained promise is the whole mutex.
 */
let askQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = askQueue.then(fn, fn);
  askQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Test seam: set the raw transport under the x402 wrapper. Pass null to restore global fetch. */
export function setPaidTransport(f: typeof fetch | null): void {
  transport = f ?? fetch;
  paidFetch = null; // rebuild the cached x402 wrapper against the new transport
  escrowFetch = null;
}

/** The transport currently wired beneath the x402 wrapper; used to assert default wiring. */
export function paidTransport(): typeof fetch {
  return transport;
}

/**
 * The shared spend guard: returns the block reason, or null and records the
 * signed price. Runs on either rail after the 402 challenge is read and before
 * anything is signed.
 */
function checkSpend(usd: number): string | null {
  const left = config.dailyCapUsd - spentTodayUsd();
  if (usd > config.maxPerCallUsd) return (lastBlock = `price $${usd} is above the per-call cap $${config.maxPerCallUsd}`);
  if (usd > left) return (lastBlock = `price $${usd} is above today's remaining budget $${left.toFixed(4)}`);
  lastBlock = null;
  signedUsd = usd;
  return null;
}

function getPaidFetch() {
  if (paidFetch) return paidFetch;
  const client = x402Client.fromConfig({
    schemes: [{ network: config.evmNetwork, client: new ExactEvmScheme(toClientEvmSigner(account())) }],
    // Telegraph's test USDC is not an x402 default asset; allow only it, with a hard atomic cap as a second fence.
    spendControls: { allowedAssets: [{ network: config.evmNetwork, asset: config.usdc, maxAmountPerPayment: String(Math.round(config.maxPerCallUsd * 1e6)) }] },
  });
  // The guard: runs after the 402 challenge, before anything is signed.
  // The hook contract is Promise<void | {abort, reason}>, so this async is
  // required by the interface even though the body only returns.
  // eslint-disable-next-line @typescript-eslint/require-await
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const reason = checkSpend(Number(selectedRequirements.amount) / 1e6);
    return reason ? { abort: true as const, reason } : undefined;
  });
  paidFetch = wrapFetchWithPayment(transport, client);
  return paidFetch;
}

function getEscrowFetch() {
  if (!escrowFetch) escrowFetch = wrapFetchWithEscrow(transport, () => account(), checkSpend);
  return escrowFetch;
}

/**
 * The paid transport buys go through. Default ("escrow") tries the escrow rail
 * first and falls back to x402 when the node still answers 402 — escrow is
 * unfunded, unpriced or not offered. Escrow signatures are never billed on a
 * refused request, so the fallback never double-charges.
 */
function payFetch(): typeof fetch {
  if (config.scheme === "x402") return getPaidFetch();
  const esc = getEscrowFetch();
  if (config.scheme === "escrow-only") return esc;
  return async (input: any, init?: any) => {
    const r = await esc(input, init);
    return r.status === 402 ? getPaidFetch()(input, init) : r;
  };
}

async function withTimeout<T>(f: (s: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), config.timeoutMs);
  try { return await f(c.signal); } finally { clearTimeout(t); }
}

export interface AskInput { query?: string; intent?: string; params?: Record<string, unknown>; why?: string; miner?: string }

/** Auto-routed by default; a miner id or slug pins the call to that miner (still bought through Telegraph). */
const minerFor = (i: AskInput) => i.miner || (i.intent ? config.pinMiners[i.intent] : undefined);
const askUrl = (i: AskInput) => { const m = minerFor(i); return `${config.nodeUrl}/engine/v1/ask${m ? "/" + encodeURIComponent(m) : ""}`; };

function body(i: AskInput) {
  return JSON.stringify(i.intent ? { intent: i.intent, params: i.params || {} } : { query: i.query });
}

/** Free: ask without paying and read the price from the 402 challenge. */
export async function quote(i: AskInput) {
  const spent = spentTodayUsd();
  const remaining = config.dailyCapUsd - spent;
  const res = await withTimeout((signal) => transport(askUrl(i), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: body(i), signal,
  }));
  if (res.status !== 402) return { status: res.status, body: (await res.text()).slice(0, 1500) };
  const ch = b64json(res.headers.get("PAYMENT-REQUIRED")) || await res.clone().json().catch(() => undefined);
  const accepts = (ch?.accepts || []).map((a: any) => ({
    scheme: a.scheme, network: a.network, payTo: a.payTo,
    usd: a.amount !== undefined ? Number(a.amount) / 1e6 : Number(String(a.price).replace(/[^\d.]/g, "")),
  }));
  const withinPerCall = accepts.some((a: any) => a.usd <= config.maxPerCallUsd);
  const withinDaily = accepts.some((a: any) => a.usd <= remaining);
  return {
    status: 402, accepts,
    within_per_call_cap: withinPerCall,
    within_daily_cap: withinDaily,
    within_caps: withinPerCall && withinDaily,
    spent_today_usd: spent,
    remaining_daily_usd: +remaining.toFixed(6),
  };
}

/** Paid: buy one answer through Telegraph, inside the caps, and record the receipt. */
export async function ask(i: AskInput) {
  if (!i.why?.trim()) {
    const reason = "every paid ask must state a why: one line on why fresh, paid data is needed instead of your own knowledge";
    record({ ts: isoNow(), status: "blocked", intent: i.intent, query: i.query, params: i.params, why: i.why, reason });
    throw new PolicyError(reason);
  }
  if (i.intent && config.allowedIntents.length && !config.allowedIntents.includes(i.intent)) {
    const reason = `intent ${i.intent} is not in PURSE_ALLOWED_INTENTS`;
    record({ ts: isoNow(), status: "blocked", intent: i.intent, why: i.why, reason });
    throw new BudgetError(reason);
  }
  if (!i.intent && config.allowedIntents.length) {
    // The node reveals the routed intent only after payment, so a plain query cannot be
    // checked against the allow-list before anything is signed. Fail closed instead.
    const reason = "PURSE_ALLOWED_INTENTS is set, so only asks that name a canonical intent are allowed; resend with intent and params";
    record({ ts: isoNow(), status: "blocked", query: i.query, params: i.params, why: i.why, reason });
    throw new BudgetError(reason);
  }
  // Serialized: the guard reads and the ledger write must be atomic with respect to other asks.
  return serialize(() => buy(i));
}

async function buy(i: AskInput) {
  signedUsd = null;
  lastBlock = null;
  const base: Entry = { ts: isoNow(), status: "failed", intent: i.intent, query: i.query, params: i.params, why: i.why, ...(minerFor(i) ? { miner_id: minerFor(i) } : {}) };
  const t0 = Date.now();

  /** A payment was signed and the answer never arrived: the money may or may not have settled, but it counts as spent. */
  const paidFailure = (reason: string, settle?: any): never => {
    // Only reached once the guard recorded a signed price, so this is a number.
    const cost = signedUsdNow() as number;
    signedUsd = null;
    record({ ...base, status: "failed_paid", cost_usd: cost, tx_hash: settle?.transaction, reason, duration_ms: Date.now() - t0 });
    throw new PaidFailureError(reason);
  };

  let res: Response;
  try {
    res = await withTimeout((signal) => payFetch()(askUrl(i), {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body(i), signal,
    }));
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!lastBlock && msg.includes("spendControls")) lastBlock = `price is above the per-call cap $${config.maxPerCallUsd}`;
    if (lastBlock) { const reason = lastBlock; lastBlock = null; signedUsd = null; record({ ...base, status: "blocked", reason }); throw new BudgetError(reason); }
    // Past the guard the payment was signed, so an abort means an uncertain settlement, never a free call.
    const signed = signedUsdNow();
    if (signed !== null) {
      return paidFailure(e?.name === "AbortError"
        ? `timed out after ${config.timeoutMs} ms after the payment was signed; settlement of $${signed} is not established`
        : `${msg} after the payment was signed; settlement is not established`);
    }
    const reason = e?.name === "AbortError" ? `timed out after ${config.timeoutMs} ms (not charged)` : msg;
    record({ ...base, reason, duration_ms: Date.now() - t0 });
    throw new Error(reason, { cause: e });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (e: any) {
    const readError = String(e?.message || e);
    const signed = signedUsdNow();
    if (signed !== null) return paidFailure(`${readError} while reading the response after the payment was signed; settlement is not established`);
    record({ ...base, reason: readError, duration_ms: Date.now() - t0 });
    throw new Error(readError, { cause: e });
  }

  if (!res.ok) {
    const reason = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    // The node can settle the payment even when the miner's upstream fails, so a signed payment counts as spent.
    const settle = b64json(res.headers.get("PAYMENT-RESPONSE")) || b64json(res.headers.get("X-PAYMENT-RESPONSE"));
    const signed = signedUsdNow();
    if (signed !== null) return paidFailure(`$${signed} was paid but no answer came back. ${reason}`, settle);
    record({ ...base, reason, duration_ms: Date.now() - t0 });
    throw new Error(reason);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    const signed = signedUsdNow();
    if (signed !== null) return paidFailure(`$${signed} was paid but the response was not valid JSON, so the answer is unknown; settlement is not established`);
    const reason = "the node returned a non-JSON body";
    record({ ...base, reason, duration_ms: Date.now() - t0 });
    throw new Error(reason);
  }

  // On the escrow rail the same receipt object rides X-PAYMENT-RESPONSE; on x402
  // that header is the settlement record and the receipt is X-TELEGRAPH-RECEIPT.
  const settle = b64json(res.headers.get("PAYMENT-RESPONSE")) || b64json(res.headers.get("X-PAYMENT-RESPONSE"));
  const receipt = b64json(res.headers.get("X-TELEGRAPH-RECEIPT")) || settle;
  const entry: Entry = {
    ...base, status: "paid",
    intent: receipt?.intent || data.intent || i.intent,
    miner_id: String(data.miner_id ?? receipt?.miner ?? ""), miner_name: data.miner_name,
    cost_usd: data.cost_usd ?? (receipt ? Number(receipt.amount_uusdc) / 1e6 : undefined),
    duration_ms: data.duration_ms ?? Date.now() - t0,
    signal_hash: data.signal_hash, receipt_hash: receipt?.receipt_hash,
    tx_hash: receipt?.tx_hash || settle?.transaction, epoch_id: receipt?.epoch_id,
    rail: receipt?.rail, settlement: receipt?.settlement,
  };
  record(entry);
  signedUsd = null;
  return { result: data.result, routing: data.routing, receipt: entry };
}

export async function balance() {
  const addr = account().address;
  const pc = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  const raw = await pc.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
  return { address: addr, network: "Ethereum Sepolia", usdc: formatUnits(raw, 6) };
}

export async function intents() {
  const r = await fetch(`${config.nodeUrl}/engine/v1/intents`);
  const d: any = await r.json();
  return (d.intents || []).filter((x: any) => x.miner_count > 0).map((x: any) => ({ intent: x.intent_id, miners: x.miner_count }));
}

export async function intentSchema(intent: string) {
  const r = await fetch(`${config.nodeUrl}/engine/v1/intents/${encodeURIComponent(intent)}`);
  const d: any = await r.json();
  return { intent, class: d.class, miners: d.miner_count, request: d.request?.params, response: d.response?.fields };
}

export async function verify(signalHash: string) {
  const r = await fetch(`${config.nodeUrl}/engine/v1/signal/${signalHash}`);
  return { status: r.status, body: (await r.text()).slice(0, 4000) };
}
