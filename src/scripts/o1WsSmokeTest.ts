import dotenv from "dotenv";
import WebSocket from "ws";
import { initWebSocketClient, Nord } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { readO1Env } from "../bot/exchanges/o1/env";
import { buildCandleSubscriptionUrl, isRelaxedCandlePayload, toWsBaseUrl } from "../bot/exchanges/o1/candleWs";

dotenv.config();

const WAIT_MS = Number(process.env.O1_WS_SMOKE_WAIT_MS ?? "25000");

type Candidate = {
  label: string;
  url: string;
  useSdk?: boolean;
};

const safePreview = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== "object") return { type: typeof payload, value: String(payload).slice(0, 200) };
  const obj = payload as Record<string, unknown>;
  const preview: Record<string, unknown> = { keys: Object.keys(obj) };
  for (const key of ["t", "o", "h", "l", "c", "v", "res", "mid", "market_id", "market_symbol", "s"]) {
    if (key in obj) preview[key] = obj[key];
  }
  if ("trades" in obj && Array.isArray(obj.trades)) preview.tradesCount = obj.trades.length;
  if ("candle" in obj) preview.nestedCandle = safePreview(obj.candle);
  if ("candles" in obj) preview.nestedCandles = Array.isArray(obj.candles) ? obj.candles.length : obj.candles;
  return preview;
};

const probeRawWs = (candidate: Candidate): Promise<{ ok: boolean; preview?: Record<string, unknown> }> => {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: { ok: boolean; preview?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    console.log(`[O1_WS_SMOKE] probing ${candidate.label}`, { url: candidate.url });
    socket = new WebSocket(candidate.url);
    timer = setTimeout(() => finish({ ok: false }), WAIT_MS);

    socket.on("open", () => {
      console.log(`[O1_WS_SMOKE] connected ${candidate.label}`);
    });

    socket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        const preview = safePreview(parsed);
        const isCandle = isRelaxedCandlePayload(parsed)
          || (parsed && typeof parsed === "object" && isRelaxedCandlePayload((parsed as { candle?: unknown }).candle));
        console.log(`[O1_WS_SMOKE] payload ${candidate.label}`, { isCandle, preview });
        finish({ ok: true, preview });
      } catch (error) {
        finish({ ok: false, preview: { parseError: String(error) } });
      }
    });

    socket.on("error", (error) => {
      console.log(`[O1_WS_SMOKE] error ${candidate.label}`, { message: String(error) });
      finish({ ok: false, preview: { error: String(error) } });
    });

    socket.on("close", (code, reason) => {
      console.log(`[O1_WS_SMOKE] closed ${candidate.label}`, { code, reason: reason.toString() });
      if (!settled) finish({ ok: false, preview: { code, reason: reason.toString() } });
    });
  });
};

const probeSdkWs = async (webServerUrl: string, subscription: string): Promise<{ ok: boolean; preview?: Record<string, unknown> }> => {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; preview?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    console.log(`[O1_WS_SMOKE] probing SDK ${subscription}`);
    const client = initWebSocketClient(webServerUrl, [subscription]);
    const timer = setTimeout(() => finish({ ok: false }), WAIT_MS);

    client.on("connected", () => {
      console.log(`[O1_WS_SMOKE] SDK connected ${subscription}`);
    });

    client.on("candle", (payload) => {
      console.log(`[O1_WS_SMOKE] SDK candle ${subscription}`, safePreview(payload));
      finish({ ok: true, preview: safePreview(payload) });
    });

    client.on("trade", (payload) => {
      console.log(`[O1_WS_SMOKE] SDK trade ${subscription}`, safePreview(payload));
      finish({ ok: true, preview: safePreview(payload) });
    });

    client.on("error", (error) => {
      console.log(`[O1_WS_SMOKE] SDK error ${subscription}`, { message: String(error) });
      finish({ ok: false, preview: { error: String(error) } });
    });
  });
};

async function main(): Promise<void> {
  const config = readO1Env();
  const symbol = process.env.O1_DEBUG_SYMBOL ?? config.symbol;
  const resolution = process.env.O1_DEBUG_RESOLUTION ?? String(config.resolution);
  const wsBase = toWsBaseUrl(config.wsUrl || config.webServerUrl);
  const httpBase = config.webServerUrl.replace(/\/$/, "");

  console.log("[O1_WS_SMOKE] starting", {
    symbol,
    resolution,
    marketId: config.marketId,
    wsBase,
    httpBase,
    waitMs: WAIT_MS,
  });

  const candidates: Candidate[] = [
    { label: "raw-candle-sdk-format", url: buildCandleSubscriptionUrl(wsBase, symbol, resolution) },
    { label: "raw-candles-plural", url: `${wsBase}/ws/candles@${symbol}:${resolution}` },
    { label: "raw-candle-no-resolution", url: `${wsBase}/ws/candle@${symbol}` },
    { label: "raw-trades", url: `${wsBase}/ws/trades@${symbol}` },
    { label: "raw-ws-candle-endpoint", url: `${wsBase}/ws/candle` },
    { label: "raw-ws-root", url: `${wsBase}/ws` },
  ];

  const results: Array<{ label: string; ok: boolean; preview?: Record<string, unknown> }> = [];

  for (const candidate of candidates) {
    const result = await probeRawWs(candidate);
    results.push({ label: candidate.label, ...result });
  }

  const sdkCandle = await probeSdkWs(httpBase, `candle@${symbol}:${resolution}`);
  results.push({ label: "sdk-initWebSocketClient-candle", ...sdkCandle });

  const sdkTrades = await probeSdkWs(httpBase, `trades@${symbol}`);
  results.push({ label: "sdk-initWebSocketClient-trades", ...sdkTrades });

  if (config.appKey && config.solanaRpcUrl) {
    try {
      const nord = await Nord.new({
        app: config.appKey,
        webServerUrl: httpBase,
        solanaConnection: new Connection(config.solanaRpcUrl),
        protonUrl: httpBase,
      });
      const bars = nord.subscribeBars(symbol, resolution as "1");
      const barsResult = await new Promise<{ ok: boolean; preview?: Record<string, unknown> }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false }), WAIT_MS);
        bars.on("message", (payload) => {
          clearTimeout(timer);
          console.log("[O1_WS_SMOKE] nord.subscribeBars message", safePreview(payload));
          bars.close();
          resolve({ ok: true, preview: safePreview(payload) });
        });
      });
      results.push({ label: "nord-subscribeBars", ...barsResult });
    } catch (error) {
      results.push({ label: "nord-subscribeBars", ok: false, preview: { error: String(error) } });
    }
  }

  console.log("[O1_WS_SMOKE] summary");
  for (const entry of results) {
    console.log(`  ${entry.ok ? "OK" : "FAIL"} ${entry.label}`, entry.preview ?? {});
  }

  const winners = results.filter((entry) => entry.ok);
  if (winners.length === 0) {
    console.log("[O1_WS_SMOKE] no websocket candidate received a payload; REST polling fallback recommended");
    process.exitCode = 1;
    return;
  }

  console.log("[O1_WS_SMOKE] working candidates:", winners.map((entry) => entry.label).join(", "));
}

main().catch((error: unknown) => {
  console.error("[O1_WS_SMOKE] failed", error);
  process.exit(1);
});
