import type { CandleResolution } from "@n1xyz/nord-ts";
import type { WebSocketCandleUpdate } from "@n1xyz/nord-ts";
import { o1Error, o1Log, o1Warn } from "./logger";
import type { O1Candle, O1EnvConfig } from "./types";

export const O1_AGGREGATED_TARGET_RESOLUTION = "3";
const ONE_MINUTE_RESOLUTION: CandleResolution = "1";

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

export const usesAggregated3mCandles = (resolution: string | CandleResolution): boolean => {
  return String(resolution) === O1_AGGREGATED_TARGET_RESOLUTION;
};

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
  o1Error("O1_CANDLE_PRELOAD", "Historical candle preload request failed.", {
    url: request.url,
    params: request.params,
    status,
    body,
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

export const aggregate1mCandlesTo3m = (oneMinuteCandles: O1Candle[]): O1Candle[] => {
  if (oneMinuteCandles.length === 0) return [];
  const bucketMs = 3 * 60 * 1000;
  const sorted = [...oneMinuteCandles].sort((left, right) => Number(left[0]) - Number(right[0]));
  const grouped = new Map<number, O1Candle[]>();

  for (const candle of sorted) {
    const openMs = Number(candle[0]);
    if (!Number.isFinite(openMs)) continue;
    const bucketStart = Math.floor(openMs / bucketMs) * bucketMs;
    const bucket = grouped.get(bucketStart) ?? [];
    bucket.push(candle);
    grouped.set(bucketStart, bucket);
  }

  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketStart, bars]) => {
      if (bars.length < 3) return null;
      const ordered = bars.sort((left, right) => Number(left[0]) - Number(right[0]));
      const open = ordered[0]![1];
      const high = String(Math.max(...ordered.map((bar) => Number(bar[2]))));
      const low = String(Math.min(...ordered.map((bar) => Number(bar[3]))));
      const close = ordered[ordered.length - 1]![4];
      const volume = String(ordered.reduce((sum, bar) => sum + Number(bar[5]), 0));
      return [
        String(bucketStart),
        open,
        high,
        low,
        close,
        volume,
        String(bucketStart),
        volume,
        "0",
        "0",
        "0",
        "0",
      ] as O1Candle;
    })
    .filter((candle): candle is O1Candle => candle !== null);
};

const loadHistoryCandles = async (
  config: O1EnvConfig,
  resolution: string,
  countback: number,
  to: number
): Promise<O1Candle[]> => {
  const request = buildTvHistoryRequest(config, resolution, countback, to);
  o1Log("O1_CANDLE_PRELOAD", "Fetching historical candles.", {
    symbol: config.symbol,
    marketId: config.marketId,
    resolution,
    countback,
    to,
    url: request.url,
    params: request.params,
  });

  const result = await fetchTvHistory(request);
  if (!result.ok) {
    logPreloadFailure(request, result.status, result.body);
    throw new Error(`Candle preload failed with HTTP ${result.status}`);
  }

  const payload = result.payload;
  if (!isHistoryOk(payload)) {
    o1Error("O1_CANDLE_PRELOAD", "Historical candle preload returned no data.", {
      url: request.url,
      params: request.params,
      status: result.status,
      body: result.body,
    });
    throw new Error(`Candle preload returned no data for ${config.symbol}:${resolution}`);
  }

  const candles = historyToCandles(payload);
  if (candles.length === 0) {
    o1Warn("O1_CANDLE_PRELOAD", "History endpoint returned zero candles.", {
      resolution,
      url: request.url,
      params: request.params,
    });
  }

  return trimCandles(candles, config.maxCandleCache);
};

const preloadAggregated3mFrom1m = async (config: O1EnvConfig, to: number): Promise<O1Candle[]> => {
  const sourceCountback = Math.min(config.maxCandleCache * 3 + 6, config.maxCandleCache * 4);
  const oneMinuteCandles = await loadHistoryCandles(config, ONE_MINUTE_RESOLUTION, sourceCountback, to);
  const aggregated = trimCandles(aggregate1mCandlesTo3m(oneMinuteCandles), config.maxCandleCache);
  o1Log("O1_CANDLE_PRELOAD_AGGREGATED", "Built 3m candles from 1m history.", {
    symbol: config.symbol,
    marketId: config.marketId,
    targetResolution: O1_AGGREGATED_TARGET_RESOLUTION,
    sourceResolution: ONE_MINUTE_RESOLUTION,
    sourceCountback,
    sourceCandleCount: oneMinuteCandles.length,
    aggregatedCandleCount: aggregated.length,
  });
  return aggregated;
};

export const preloadO1Candles = async (config: O1EnvConfig): Promise<O1Candle[]> => {
  const to = Math.floor(Date.now() / 1000);
  const resolution = String(config.resolution);

  if (!usesAggregated3mCandles(resolution)) {
    const candles = await loadHistoryCandles(config, resolution, config.maxCandleCache, to);
    o1Log("O1_CANDLE_PRELOAD", "Historical candles loaded.", {
      symbol: config.symbol,
      marketId: config.marketId,
      resolution,
      preloadedCandleCount: candles.length,
    });
    return candles;
  }

  const directRequest = buildTvHistoryRequest(config, resolution, config.maxCandleCache, to);
  const directResult = await fetchTvHistory(directRequest);
  if (directResult.ok && isHistoryOk(directResult.payload)) {
    const candles = trimCandles(historyToCandles(directResult.payload), config.maxCandleCache);
    o1Log("O1_CANDLE_PRELOAD", "Historical candles loaded.", {
      symbol: config.symbol,
      marketId: config.marketId,
      resolution,
      preloadedCandleCount: candles.length,
    });
    return candles;
  }

  if (!directResult.ok) {
    logPreloadFailure(directRequest, directResult.status, directResult.body);
    o1Warn("O1_CANDLE_PRELOAD", "Direct 3m preload failed; falling back to 1m aggregation.", {
      status: directResult.status,
      body: directResult.body,
      url: directRequest.url,
      params: directRequest.params,
    });
  } else {
    o1Warn("O1_CANDLE_PRELOAD", "Direct 3m preload returned no data; falling back to 1m aggregation.", {
      status: directResult.status,
      body: directResult.body,
      url: directRequest.url,
      params: directRequest.params,
    });
  }

  return preloadAggregated3mFrom1m(config, to);
};

export const rebuildAggregated3mCandles = (oneMinuteCandles: O1Candle[], maxSize: number): O1Candle[] => {
  return trimCandles(aggregate1mCandlesTo3m(oneMinuteCandles), maxSize);
};
