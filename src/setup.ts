// One-command setup: npm run setup
// Creates .env with a fresh burner wallet (if none), shows balances, mints test USDC
// when the wallet has Sepolia ETH for gas, installs the Hermes skill and prints the MCP entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, erc20Abi, formatEther, formatUnits, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const MINT_USDC = "5";

// 1. .env and burner wallet
if (!fs.existsSync(envPath)) fs.copyFileSync(path.join(root, ".env.example"), envPath);
let env = fs.readFileSync(envPath, "utf8");
let key = env.match(/^TELEGRAPH_EVM_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m)?.[1];
if (!key) {
  key = generatePrivateKey();
  env = /^TELEGRAPH_EVM_PRIVATE_KEY=.*$/m.test(env)
    ? env.replace(/^TELEGRAPH_EVM_PRIVATE_KEY=.*$/m, `TELEGRAPH_EVM_PRIVATE_KEY=${key}`)
    : env + `\nTELEGRAPH_EVM_PRIVATE_KEY=${key}\n`;
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log("✓ New burner wallet written to .env (never share this file)");
} else console.log("✓ Using the wallet already in .env");

const account = privateKeyToAccount(key as `0x${string}`);
const usdc = ((env.match(/^USDC_ADDRESS=(0x[0-9a-fA-F]{40})/m)?.[1]) || "0xcc194e1a843B658526D0D5C431f670028582Ae17") as `0x${string}`;
const rpc = env.match(/^SEPOLIA_RPC=(\S+)/m)?.[1] || "https://ethereum-sepolia-rpc.publicnode.com";
const pc = createPublicClient({ chain: sepolia, transport: http(rpc) });

// 2. balances, and mint test USDC if empty
const eth = await pc.getBalance({ address: account.address });
let bal = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`  address  ${account.address}`);
console.log(`  Sepolia  ${formatEther(eth)} ETH, ${formatUnits(bal, 6)} test USDC`);

if (bal === 0n && eth > 0n) {
  const wc = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
  try {
    const hash = await wc.writeContract({ address: usdc, abi: mintAbi, functionName: "mint", args: [account.address, parseUnits(MINT_USDC, 6)] });
    await pc.waitForTransactionReceipt({ hash });
    bal = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    console.log(`✓ Minted ${MINT_USDC} test USDC (tx ${hash})`);
  } catch (e: any) {
    console.log(`! Mint failed (${e.shortMessage || e.message}). Use the Anjoman faucet instead.`);
  }
} else if (bal === 0n) {
  console.log("! No Sepolia ETH for gas. Get a little from any Sepolia faucet, then run npm run setup again.");
}

// 3. Hermes skill
const hermesSkills = path.join(os.homedir(), ".hermes", "skills");
if (fs.existsSync(path.dirname(hermesSkills))) {
  const dest = path.join(hermesSkills, "telegraph-purse");
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(root, "skills", "telegraph-purse", "SKILL.md"), path.join(dest, "SKILL.md"));
  console.log(`✓ Hermes skill installed to ${dest}`);
}

// 4. MCP entry to paste
const entry = path.join(root, "dist", "index.js");
console.log(`
Add this under mcp_servers: in ~/.hermes/config.yaml (or your MCP client's config):

  purse:
    command: node
    args: ["${entry}"]
    cwd: ${root}

Then: hermes mcp test purse${bal > 0n ? "" : "   (fund the wallet first for paid asks)"}
`);
