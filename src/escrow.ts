/**
 * Telegraph escrow payment rail: same engine ask, same intent/params, but the
 * 402 is answered by an EIP-191 personal_sign over the node's own message
 * template instead of an on-chain x402 settlement. No facilitator round trip;
 * billing lands in the epoch's ledger root.
 */
import type { privateKeyToAccount } from "viem/accounts";

/** Thrown when the spend guard refuses the quoted price, before anything is signed. */
export class EscrowBlocked extends Error {}

interface EscrowAccepts {
  scheme?: string;
  network?: string;
  payTo?: string;
  extra?: { message?: string };
}

const b64json = (v: string | null) => {
  if (!v) return undefined;
  try { return JSON.parse(Buffer.from(v, "base64").toString("utf8")); } catch { return undefined; }
};

async function challengeAccepts(res: Response): Promise<EscrowAccepts[] | null> {
  const ch = b64json(res.headers.get("PAYMENT-REQUIRED"));
  if (ch?.accepts) return ch.accepts;
  try {
    const body = await res.clone().json() as { accepts?: EscrowAccepts[] };
    return body?.accepts ?? null;
  } catch {
    return null;
  }
}

type Account = ReturnType<typeof privateKeyToAccount>;

/**
 * Returns a fetch compatible with wrapFetchWithPayment: sends the request once,
 * and on a 402 finds the `scheme:"escrow"` accepts entry, runs the spend guard
 * on the template's quoted amount, signs the message and retries with the
 * X-PAYMENT header. If the node offers no escrow entry the 402 is returned
 * untouched so the caller can fall back to another rail.
 */
export function wrapFetchWithEscrow(
  transport: typeof fetch,
  account: () => Account,
  checkSpend: (usd: number) => string | null,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await transport(input, init);
    if (res.status !== 402) return res;

    const esc = (await challengeAccepts(res))?.find((a) => a.scheme === "escrow" && a.extra?.message);
    const m = esc?.extra?.message?.match(/Amount:\s*(\d+)\s*uUSDC/);
    if (!esc || !m) return res;

    const blocked = checkSpend(Number(m[1]) / 1e6);
    if (blocked) throw new EscrowBlocked(blocked);

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account().address.toLowerCase(), // the node lowercases before verifying
      to: esc.payTo,
      value: m[1],                           // exact quoted amount, read off the signed template
      validAfter: String(now - 5),
      validBefore: String(now + 100),        // the window may not exceed 2 minutes
      nonce: crypto.randomUUID(),            // remembered across nodes; never reuse
    };
    const message = esc.extra!.message!
      .replace("{from}", authorization.from)
      .replace("{nonce}", authorization.nonce)
      .replace("{validAfter}", authorization.validAfter)
      .replace("{validBefore}", authorization.validBefore);
    if (message.includes("{") || message.includes("}"))
      throw new Error("the escrow challenge template has a placeholder the purse cannot fill; refusing to sign it");
    const signature = await account().signMessage({ message });

    const payment = Buffer.from(JSON.stringify({
      x402Version: 2, scheme: "escrow", network: esc.network,
      payload: { signature, authorization },
    })).toString("base64");
    const headers = new Headers(new Request(input, init).headers);
    headers.set("X-PAYMENT", payment); // escrow is read from X-PAYMENT, never PAYMENT-SIGNATURE
    return transport(input, { ...init, headers });
  };
}
