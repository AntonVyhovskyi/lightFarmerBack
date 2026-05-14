import type { WebSocketCandleUpdate } from "@n1xyz/nord-ts";
import { o1Log, o1Warn } from "./logger";
import type { O1Candle, O1EnvConfig } from "./types";

const MIN_STRATEGY_CANDLES = 120;

type TvHistoryOk = {
  s: "ok";
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
};

type TvHistoryNoData = {
  s: "no_data";
  nextTime?: string;
};

const toCandle = (payload: Pick<WebSocketCandleUpdate, "t" | "o" | "h" | "l" | "c" | "v">): O1Candle => {
  const tsMs = Number(payload.t) * 1000;
  return [
    String(tsMs),
    String(payload.o),
    String(payload.h),
    String(payload.l),
    String(payload.c),
    String(payload.v),
    String(tsMs),
    String(payload.v),
    "0",
    "0",
    "0",
    "0",
  ];
};

const isHistoryOk = (payload: unknown): payload is TvHistoryOk => {
  if (!payload || typeof payload !== "object") return false;
  const data = payload as TvHistoryOk;
  return data.s === "ok"
    && Array.isArray(data.t)
    && Array.isArray(data.o)
    && Array.isArray(data.h)
    && Array.isArray(data.l)
    && Array.isArray(data.c)
    && Array.isArray(data.v);
};

export const preloadO1Candles = async (config: O1EnvConfig): Promise<O1Candle[]> => {
  const countback = config.maxCandleCache;
  const to = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    symbol: config.symbol,
    resolution: config.resolution,
    countback: String(countback),
    to: String(to),
    market_id: String(config.marketId),
  });

  const url = `${config.webServerUrl.replace(/\/$/, "")}/tv/history?${params.toString()}`;
  o1Log("O1_CANDLE_PRELOAD", "Fetching historical candles.", {
    symbol: config.symbol,
    marketId: config.marketId,
    resolution: config.resolution,
    countback,
  });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Candle preload failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as TvHistoryOk | TvHistoryNoData;
  if (!isHistoryOk(payload)) {
    throw new Error(`Candle preload returned no data for ${config.symbol}:${config.resolution}`);
  }

  const length = payload.t.length;
  if (length === 0) {
    o1Warn("O1_CANDLE_PRELOAD", "History endpoint returned zero candles.");
    return [];
  }

  const candles = payload.t.map((timestamp, index) => toCandle({
    t: timestamp,
    o: payload.o[index],
    h: payload.h[index],
    l: payload.l[index],
    c: payload.c[index],
    v: payload.v[index],
  }));

  candles.sort((a, b) => Number(a[0]) - Number(b[0]));
  const trimmed = candles.length > config.maxCandleCache
    ? candles.slice(candles.length - config.maxCandleCache)
    : candles;

  o1Log("O1_CANDLE_PRELOAD", "Historical candles loaded.", {
    symbol: config.symbol,
    marketId: config.marketId,
    resolution: config.resolution,
    preloadedCandleCount: trimmed.length,
  });

  return trimmed;
};
