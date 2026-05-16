import type { WebSocketCandleUpdate } from "@n1xyz/nord-ts";
import { aggregate1mCandlesTo3m } from "./candleAggregation";
import {
  O1_AGGREGATED_TARGET_RESOLUTION,
  resolveO1CandleHandling,
  usesAggregatedCandles,
} from "./candleResolution";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import type { O1Candle, O1EnvConfig } from "./types";

const ONE_MINUTE_RESOLUTION = "1";

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

export type O1TvHistoryRequest = {
  url: string;
  params: Record<string, string>;
};

export type O1TvHistoryFetchResult = {
  ok: boolean;
  status: number;
  body: string;
  payload: TvHistoryOk | TvHistoryNoData | null;
  request: O1TvHistoryRequest;
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

export { O1_AGGREGATED_TARGET_RESOLUTION, usesAggregated3mCandles } from "./candleResolution";

export const buildTvHistoryRequest = (
  config: Pick<O1EnvConfig, "webServerUrl" | "symbol" | "marketId">,
  resolution: string,
  countback: number,
  to: number
): O1TvHistoryRequest => {
  const params = {
    symbol: config.symbol,
    resolution,
    countback: String(countback),
    to: String(to),
    market_id: String(config.marketId),
  };
  const url = `${config.webServerUrl.replace(/\/$/, "")}/tv/history?${new URLSearchParams(params).toString()}`;
  return { url, params };
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

const historyToCandles = (payload: TvHistoryOk): O1Candle[] => {
  const candles = payload.t.map((timestamp, index) => toCandle({
    t: timestamp,
    o: payload.o[index]!,
    h: payload.h[index]!,
    l: payload.l[index]!,
    c: payload.c[index]!,
    v: payload.v[index]!,
  }));
  candles.sort((left, right) => Number(left[0]) - Number(right[0]));
  return candles;
};

const trimCandles = (candles: O1Candle[], maxSize: number): O1Candle[] => {
  return candles.length > maxSize ? candles.slice(candles.length - maxSize) : candles;
};

const logPreloadFailure = (request: O1TvHistoryRequest, status: number, body: string): void => {
  logError("O1_CANDLE_PRELOAD", "Historical candle preload request failed", {
    resolution: request.params.resolution,
    status,
    body: body.slice(0, 200),
  });
};

export const fetchTvHistory = async (request: O1TvHistoryRequest): Promise<O1TvHistoryFetchResult> => {
  const response = await fetch(request.url);
  const body = await response.text();
  let payload: TvHistoryOk | TvHistoryNoData | null = null;
  try {
    payload = body ? JSON.parse(body) as TvHistoryOk | TvHistoryNoData : null;
  } catch {
    payload = null;
  }

  return {
    ok: response.ok && isHistoryOk(payload),
    status: response.status,
    body,
    payload,
    request,
  };
};

export const rebuildAggregated3mCandles = (oneMinuteCandles: O1Candle[], maxSize: number): O1Candle[] => {
  const aggregated = aggregate1mCandlesTo3m(oneMinuteCandles);
  return trimCandles(aggregated, maxSize);
};

const loadHistoryCandles = async (
  config: O1EnvConfig,
  resolution: string,
  countback: number,
  to: number
): Promise<O1Candle[]> => {
  const request = buildTvHistoryRequest(config, resolution, countback, to);
  logDebug("O1_CANDLE_PRELOAD", "Fetching historical candles", {
    symbol: config.symbol,
    resolution,
    countback,
  });

  const result = await fetchTvHistory(request);
  if (!result.ok) {
    logPreloadFailure(request, result.status, result.body);
    throw new Error(`Candle preload failed with HTTP ${result.status}`);
  }

  const payload = result.payload;
  if (!isHistoryOk(payload)) {
    logError("O1_CANDLE_PRELOAD", "Historical candle preload returned no data", {
      resolution,
      status: result.status,
    });
    throw new Error(`Candle preload returned no data for ${config.symbol}:${resolution}`);
  }

  const candles = historyToCandles(payload);
  if (candles.length === 0) {
    logWarn("O1_CANDLE_PRELOAD", "History endpoint returned zero candles", { resolution });
  }

  return trimCandles(candles, config.maxCandleCache);
};

const preloadAggregatedFrom1m = async (config: O1EnvConfig, to: number): Promise<O1Candle[]> => {
  const sourceCountback = Math.min(config.maxCandleCache * 3 + 6, config.maxCandleCache * 4);
  const oneMinuteCandles = await loadHistoryCandles(config, ONE_MINUTE_RESOLUTION, sourceCountback, to);
  const aggregated = trimCandles(aggregate1mCandlesTo3m(oneMinuteCandles), config.maxCandleCache);
  logInfo("O1_CANDLE_PRELOAD_AGGREGATED", "Built aggregated candles from 1m history", {
    sourceCandleCount: oneMinuteCandles.length,
    aggregatedCandleCount: aggregated.length,
    effectiveResolution: O1_AGGREGATED_TARGET_RESOLUTION,
  });
  return aggregated;
};

export const preloadO1Candles = async (config: O1EnvConfig): Promise<O1Candle[]> => {
  const handling = resolveO1CandleHandling(config);
  const to = Math.floor(Date.now() / 1000);

  if (!usesAggregatedCandles(handling)) {
    const candles = await loadHistoryCandles(config, handling.effectiveResolution, config.maxCandleCache, to);
    logInfo("O1_CANDLE_PRELOAD", "Historical candles loaded", {
      resolution: handling.effectiveResolution,
      preloadedCandleCount: candles.length,
      candleMode: handling.mode,
    });
    return candles;
  }

  return preloadAggregatedFrom1m(config, to);
};
