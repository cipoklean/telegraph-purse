# Report to Telegraph: settlement behavior on upstream failure

**Date:** 2026-11-09
**From:** Telegraph Purse (Hackathon Season II, Mission 09 — Personal Agent)
**Topic:** The node settles payment even when the miner's upstream call fails (HTTP 500/530), contrary to the documented "pays only on success" contract.

---

## 1. Observation

On 2026-11-01, a Hermes agent asked for current Lagos temperature through the purse's `purse_ask` (`WEATHER_CHECK_TEMPERATURE`, params `{location: "Lagos"}`). The auto-router picked a weather miner whose upstream host was down (Cloudflare Tunnel error 1033, HTTP 530 surfaced as HTTP 500 by the node). The node returned an error — **but the 0.01 test USDC payment still settled on-chain.**

All eight failed asks from that session settled. Each produced an on-chain transfer of 0.01 USDC from the purse wallet `0x51b0228bd9B8BF78CEDB11Cb485BA9F80cCf4655` to the node's payment address `0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b`.

### Settled-on-failure transfers (all 0.01 USDC, Ethereum Sepolia)

| Time (UTC) | Reason | Block | Tx hash |
|---|---|---|---|
| 2026-11-01 18:14:42 | HTTP 500, tunnel 1033 | 12042728 | 0xd0031531978550abc63c11be7f0f7fdd7aafe33897a2f323b900fe294313bff1 |
| 2026-11-01 18:15:08 | HTTP 500, tunnel 1033 | 12042730 | 0x2d960ee6d554e160992af2d3e7b71b21f45415f80ac81ff899159257e126433d |
| 2026-11-01 18:24:12 | HTTP 500, tunnel 1033 | 12042776 | 0xa90f409dff94395de44731547bf4428b3402165926239dd40a34887bec10d0ba |
| 2026-11-01 18:24:43 | HTTP 500, tunnel 1033 | 12042778 | 0x99f7693bb91f182608c6d773b3208a605ba153a2c35e4df62deb36d01c8be052 |
| 2026-11-01 18:42:35 | HTTP 500, circuit opened | 12042868 | 0x2cd33b6dc9f855df77bd1f43f3bfa060a097e6cab26c2bdae4996cbf66d96703 |
| 2026-11-01 18:43:10 | HTTP 500, tunnel 1033 | 12042871 | 0x1e707ba7cf56e4430da11cbc858d1efd63877e04c9bde4abdf032afbf08737f3 |
| 2026-11-01 22:03:18 | HTTP 500, tunnel 1033 | 12043867 | 0xc453c8c76c6ccc8c7275855b79212e6e09303251dd20ec7a8d521936239dbe25 |
| 2026-11-01 22:03:45 | HTTP 500, tunnel 1033 | 12043869 | 0xdad34aea6e9677ec7e1aec2f7f1baf00f8f90efd50f32d08696347208e6f2ff1 |

All eight are verifiable on Etherscan Sepolia. That observation's Nov 1 subset was **11 settled 0.01 USDC transfers: 3 paid BTC buys plus these 8 failed_paid weather asks**. Dated observation, not the final history: the wallet has since settled further transfers, so the running total is larger than 11. The 11 above are the subset observed on 2026-11-01.

## 2. Impact on the client

- The agent-side purse records these as `failed_paid` — payment signed and settled, no answer returned. This status counts against the daily cap, so a client can't be farmed for free answers through failing miners.
- The docs' wording implies a failed call should cost nothing. In practice the payment settled, so a client that treats "HTTP 5xx = not charged" will under-report spend.
- The purse went further: the weather intent is now pinned to a working miner (`PURSE_PIN_MINERS=WEATHER_CHECK_TEMPERATURE=20260821`) to avoid paying for failures.

## 3. Suggested doc fix

Clarify the settlement contract: a signed payment settles on the node regardless of the miner's upstream result; the client is charged when it signs, not when the miner succeeds. Encourage clients to treat any signed request as a spend (paid or `failed_paid`), and to pin known-good miners where available.

## 4. Second observation: chain mismatch with docs

Telegraph's docs reference Base Sepolia (chain id 84532) as the settlement network, but the live devnode actually pays in test USDC on **Ethereum Sepolia** (chain id 11155111), token `0xcc194e1a843B658526D0D5C431f670028582Ae17`. Verified both on 2026-11-01 and re-verified 2026-11-09. Worth confirming which chain is canonical for the current node.
