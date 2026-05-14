import dotenv from "dotenv";
import { readO1Env } from "../bot/exchanges/o1/env";
import { buildTvHistoryRequest, fetchTvHistory } from "../bot/exchanges/o1/candlePreload";

dotenv.config();

const RESOLUTIONS = ["1", "3", "5", "15"] as const;

async function main() {
  const config = readO1Env();
  const symbol = process.env.O1_DEBUG_SYMBOL ?? config.symbol ?? "SOLUSD";
  const marketId = Number(process.env.O1_DEBUG_MARKET_ID ?? config.marketId ?? 2);
  const countback = Number(process.env.O1_DEBUG_COUNTBACK ?? "50");
  const to = Math.floor(Date.now() / 1000);

  console.log("[O1_CANDLE_PRELOAD_DEBUG] starting", {
    webServerUrl: config.webServerUrl,
    symbol,
    marketId,
    countback,
    to,
  });

  for (const resolution of RESOLUTIONS) {
    const request = buildTvHistoryRequest(
      { webServerUrl: config.webServerUrl, symbol, marketId },
      resolution,
      countback,
      to
    );
    const result = await fetchTvHistory(request);
    console.log("[O1_CANDLE_PRELOAD_DEBUG] result", {
      resolution,
      status: result.status,
      ok: result.ok,
      url: request.url,
      params: request.params,
      body: result.body,
      candleCount: result.payload && "t" in result.payload ? result.payload.t.length : 0,
    });
  }
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error("[O1_CANDLE_PRELOAD_DEBUG] failed", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
