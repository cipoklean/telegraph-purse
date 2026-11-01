import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
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

export function account() {
  if (!config.privateKey) throw new Error("TELEGRAPH_EVM_PRIVATE_KEY is not set");
  return privateKeyToAccount(config.privateKey as `0x${string}`);
}

let paidFetch: typeof fetch | null = null;
let lastBlock: string | null = null;
/** Price of the payment signed for the current ask, if any. */
let signedUsd: number | null = null;

function getPaidFetch() {
  if (paidFetch) return paidFetch;
  const client = x402Client.fromConfig({
    schemes: [{ network: config.evmNetwork, client: new ExactEvmScheme(toClientEvmSigner(account())) }],
    // Telegraph's test USDC is not an x402 default asset; allow only it, with a hard atomic cap as a second fence.
    spendControls: { allowedAssets: [{ network: config.evmNetwork, asset: config.usdc, maxAmountPerPayment: String(Math.round(config.maxPerCallUsd * 1e6)) }] },
  });
  // The guard: runs after the 402 challenge, before anything is signed.
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const usd = Number(selectedRequirements.amount) / 1e6;
    const left = config.dailyCapUsd - spentTodayUsd();
    if (usd > config.maxPerCallUsd) lastBlock = `price $${usd} is above the per-call cap $${config.maxPerCallUsd}`;
    else if (usd > left) lastBlock = `price $${usd} is above today's remaining budget $${left.toFixed(4)}`;
    else { lastBlock = null; signedUsd = usd; return; }
    return { abort: true as const, reason: lastBlock };
  });
  paidFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  return paidFetch;
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
  const res = await withTimeout((signal) => fetch(askUrl(i), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: body(i), signal,
  }));
  if (res.status !== 402) return { status: res.status, body: (await res.text()).slice(0, 1500) };
  const ch = b64json(res.headers.get("PAYMENT-REQUIRED"));
  const accepts = (ch?.accepts || []).map((a: any) => ({ network: a.network, usd: Number(a.amount) / 1e6, payTo: a.payTo }));
  return { status: 402, accepts, within_caps: accepts.some((a: any) => a.usd <= config.maxPerCallUsd) };
}

/** Paid: buy one answer through Telegraph, inside the caps, and record the receipt. */
export async function ask(i: AskInput) {
  if (i.intent && config.allowedIntents.length && !config.allowedIntents.includes(i.intent)) {
    const reason = `intent ${i.intent} is not in PURSE_ALLOWED_INTENTS`;
    record({ ts: isoNow(), status: "blocked", intent: i.intent, why: i.why, reason });
    throw new BudgetError(reason);
  }
  signedUsd = null;
  const base: Entry = { ts: isoNow(), status: "failed", intent: i.intent, query: i.query, params: i.params, why: i.why, ...(minerFor(i) ? { miner_id: minerFor(i) } : {}) };
  const t0 = Date.now();
  let res: Response;
  try {
    res = await withTimeout((signal) => getPaidFetch()(askUrl(i), {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body(i), signal,
    }));
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!lastBlock && msg.includes("spendControls")) lastBlock = `price is above the per-call cap $${config.maxPerCallUsd}`;
    if (lastBlock) { const reason = lastBlock; lastBlock = null; record({ ...base, status: "blocked", reason }); throw new BudgetError(reason); }
    const reason = e?.name === "AbortError" ? `timed out after ${config.timeoutMs} ms (not charged)` : String(e?.message || e);
    record({ ...base, reason, duration_ms: Date.now() - t0 });
    throw new Error(reason);
  }
  const text = await res.text();
  if (!res.ok) {
    const reason = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    // The node can settle the payment even when the miner's upstream fails, so a signed payment counts as spent.
    const settle = b64json(res.headers.get("PAYMENT-RESPONSE"));
    if (signedUsd !== null) {
      const cost = signedUsd;
      record({ ...base, status: "failed_paid", cost_usd: cost, tx_hash: settle?.transaction, reason, duration_ms: Date.now() - t0 });
      throw new PaidFailureError(`$${cost} was paid but no answer came back. ${reason}`);
    }
    record({ ...base, reason, duration_ms: Date.now() - t0 });
    throw new Error(reason);
  }
  const data = JSON.parse(text);
  const receipt = b64json(res.headers.get("X-TELEGRAPH-RECEIPT"));
  const settle = b64json(res.headers.get("PAYMENT-RESPONSE"));
  const entry: Entry = {
    ...base, status: "paid",
    intent: receipt?.intent || data.intent || i.intent,
    miner_id: String(data.miner_id ?? receipt?.miner ?? ""), miner_name: data.miner_name,
    cost_usd: data.cost_usd ?? (receipt ? Number(receipt.amount_uusdc) / 1e6 : undefined),
    duration_ms: data.duration_ms ?? Date.now() - t0,
    signal_hash: data.signal_hash, receipt_hash: receipt?.receipt_hash,
    tx_hash: receipt?.tx_hash || settle?.transaction, epoch_id: receipt?.epoch_id,
  };
  record(entry);
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
