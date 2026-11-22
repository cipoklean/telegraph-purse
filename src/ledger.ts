import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface Entry {
  ts: string;
  status: "paid" | "blocked" | "failed" | "failed_paid";
  intent?: string;
  query?: string;
  params?: Record<string, unknown>;
  why?: string;
  miner_id?: string;
  miner_name?: string;
  cost_usd?: number;
  duration_ms?: number;
  signal_hash?: string;
  receipt_hash?: string;
  tx_hash?: string;
  epoch_id?: number;
  rail?: string;
  settlement?: string;
  reason?: string;
  /** true when the ask named its miner (pin or `miner`), false when the node auto-routed it. */
  pinned?: boolean;
}

export function record(e: Entry) {
  fs.mkdirSync(path.dirname(config.ledgerPath), { recursive: true });
  fs.appendFileSync(config.ledgerPath, JSON.stringify(e) + "\n");
}

export function readAll(): Entry[] {
  if (!fs.existsSync(config.ledgerPath)) return [];
  return fs.readFileSync(config.ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** UTC timestamp built by hand so it is ISO 8601 on every runtime. */
export function isoNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}
const today = () => isoNow().slice(0, 10);

const spent = (e: Entry) => e.status === "paid" || e.status === "failed_paid";

export function spentTodayUsd(): number {
  return readAll().filter((e) => spent(e) && e.ts.startsWith(today())).reduce((s, e) => s + (e.cost_usd || 0), 0);
}

export function summary() {
  const all = readAll();
  const paid = all.filter((e) => e.status === "paid");
  const byIntent: Record<string, { calls: number; usd: number; avg_ms: number }> = {};
  for (const e of paid) {
    const k = e.intent || "auto";
    byIntent[k] ??= { calls: 0, usd: 0, avg_ms: 0 };
    const b = byIntent[k];
    b.avg_ms = (b.avg_ms * b.calls + (e.duration_ms || 0)) / (b.calls + 1);
    b.calls++;
    b.usd += e.cost_usd || 0;
  }
  return {
    spent_today_usd: +spentTodayUsd().toFixed(6),
    daily_cap_usd: config.dailyCapUsd,
    max_per_call_usd: config.maxPerCallUsd,
    paid_calls: paid.length,
    blocked_calls: all.filter((e) => e.status === "blocked").length,
    failed_calls: all.filter((e) => e.status === "failed").length,
    failed_paid_calls: all.filter((e) => e.status === "failed_paid").length,
    total_usd: +all.filter(spent).reduce((s, e) => s + (e.cost_usd || 0), 0).toFixed(6),
    by_intent: byIntent,
  };
}

/**
 * Paid failures in the last `windowMs` for one target: a named miner, or (when no miner is named)
 * the auto-routed asks for an intent. Returns their timestamps, oldest first.
 */
export function recentPaidFailures(target: { miner?: string; intent?: string }, windowMs: number, now = Date.now()): number[] {
  return readAll()
    .filter((e) => e.status === "failed_paid")
    .filter((e) => target.miner ? e.miner_id === target.miner : !e.pinned && e.intent === target.intent)
    .map((e) => Date.parse(e.ts))
    .filter((t) => !isNaN(t) && now - t < windowMs)
    .sort((a, b) => a - b);
}
