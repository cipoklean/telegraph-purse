// Smoke test without spending: list live intents, schemas and a free price quote.
import { intents, intentSchema, quote } from "./purse.js";
import { summary } from "./ledger.js";
const live: { intent: string; miners: number }[] = await intents();
console.log("live intents:", live.length);
for (const i of ["CRYPTO_PRICE_USD", "WEATHER_CHECK_TEMPERATURE", "WEB_SEARCH_GENERAL", "QUESTION_ANSWERING_GENERAL"]) {
  console.log(i, live.find((x) => x.intent === i)?.miners ?? 0, "miners", JSON.stringify((await intentSchema(i)).request));
}
console.log("quote BTC:", JSON.stringify(await quote({ intent: "CRYPTO_PRICE_USD", params: { symbol: "BTC" } })));
console.log("quote weather:", JSON.stringify(await quote({ intent: "WEATHER_CHECK_TEMPERATURE", params: { location: "Lagos" } })));
console.log("budget:", JSON.stringify(summary()));
