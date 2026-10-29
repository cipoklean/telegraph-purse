import "dotenv/config";
import os from "node:os";
import path from "node:path";

const num = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);

export const config = {
  nodeUrl: (process.env.TELEGRAPH_NODE_URL || "https://devnode.telegraphprotocol.com").replace(/\/$/, ""),
  privateKey: process.env.TELEGRAPH_EVM_PRIVATE_KEY || "",
  evmNetwork: (process.env.EVM_NETWORK || "eip155:11155111") as `${string}:${string}`,
  rpcUrl: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
  usdc: (process.env.USDC_ADDRESS || "0xcc194e1a843B658526D0D5C431f670028582Ae17") as `0x${string}`,
  maxPerCallUsd: num(process.env.PURSE_MAX_PER_CALL_USD, 0.05),
  dailyCapUsd: num(process.env.PURSE_DAILY_CAP_USD, 0.5),
  timeoutMs: num(process.env.PURSE_TIMEOUT_MS, 60000),
  allowedIntents: (process.env.PURSE_ALLOWED_INTENTS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ledgerPath: process.env.PURSE_LEDGER || path.join(os.homedir(), ".telegraph-purse", "ledger.jsonl"),
};
