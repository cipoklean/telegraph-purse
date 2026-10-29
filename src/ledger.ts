import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface Entry {
  ts: string;
  status: "paid" | "blocked" | "failed";
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
  reason?: string;
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

export function spentTodayUsd(): number {
  return readAll().filter((e) => e.status === "paid" && e.ts.startsWith(today())).reduce((s, e) => s + (e.cost_usd || 0), 0);
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
    total_usd: +paid.reduce((s, e) => s + (e.cost_usd || 0), 0).toFixed(6),
    by_intent: byIntent,
  };
}
