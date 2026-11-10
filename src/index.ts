#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask, quote, balance, intents, intentSchema, verify, BudgetError, PaidFailureError, PolicyError } from "./purse.js";
import { readAll, summary } from "./ledger.js";

const server = new McpServer({ name: "telegraph-purse", version: "0.1.0" });
const out = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const err = (m: string) => ({ isError: true, content: [{ type: "text" as const, text: m }] });

const askShape = {
  query: z.string().optional().describe("Plain-language question; Telegraph picks the intent. Use when no intent fits."),
  intent: z.string().optional().describe("Canonical intent, e.g. CRYPTO_PRICE_USD, WEATHER_CHECK_TEMPERATURE, WEB_SEARCH_GENERAL"),
  params: z.record(z.string(), z.unknown()).optional().describe("Typed params for the intent, e.g. {symbol:'BTC'} or {location:'Lagos'}"),
  miner: z.string().optional().describe("Optional miner id or slug to pin this call to one miner (still bought through Telegraph). Leave empty to auto-route."),
  why: z.string().min(1, "why must not be empty").describe("One line: why fresh, paid data is needed instead of your own knowledge"),
};

server.tool("purse_ask", "Buy one answer from the Telegraph network with USDC (x402). Enforces per-call and daily caps and records a receipt. Only for live or fresh facts.", askShape, async (a) => {
  if (!a.query && !a.intent) return err("Give either query or intent.");
  try { return out(await ask(a)); } catch (e: any) { return err((e instanceof BudgetError ? "BLOCKED by budget: " : e instanceof PaidFailureError ? "FAILED (paid, no answer): " : e instanceof PolicyError ? "BLOCKED by policy: " : "FAILED (not charged): ") + e.message); }
});
server.tool("purse_quote", "Free. See what a Telegraph answer would cost without paying.", askShape, async (a) => out(await quote(a)));
server.tool("purse_budget", "Free. Spend today vs caps, totals, and per-intent cost and latency.", {}, async () => out(summary()));
server.tool("purse_receipts", "Free. Most recent purchases with signal hash, receipt hash and settlement tx.", { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => out(readAll().slice(-limit).reverse()));
server.tool("purse_balance", "Free. USDC balance of the purse wallet on Ethereum Sepolia (Telegraph test USDC).", {}, async () => { try { return out(await balance()); } catch (e: any) { return err(e.message); } });
server.tool("purse_intents", "Free. Intents that currently have live miners. Pass intent to get its request params.", { intent: z.string().optional() }, async ({ intent }) => out(intent ? await intentSchema(intent) : await intents()));
server.tool("purse_verify", "Free. Look up a purchase's signal on the node to prove what was bought.", { signal_hash: z.string() }, async ({ signal_hash }) => out(await verify(signal_hash)));

await server.connect(new StdioServerTransport());
console.error("[telegraph-purse] ready");
