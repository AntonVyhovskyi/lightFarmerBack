import { fetchRecentHistoryCandles } from "./candlePreload";
import { logDebug, logInfo, logWarn } from "./logger";
import type { O1Candle, O1EnvConfig } from "./types";

export type O1CandlePollResult = {
  fetchedCount: number;
  ingestedCount: number;
  latestTs: number | null;
  closedDetected: boolean;
};

export const pollRecentCandles = async ({
  config,
  streamResolution,
  countback,
  lastIngestedTs,
  onCandle,
}: {
  config: O1EnvConfig;
  streamResolution: string;
  countback: number;
  lastIngestedTs: number | null;
  onCandle: (candle: O1Candle) => void;
}): Promise<O1CandlePollResult> => {
  const candles = await fetchRecentHistoryCandles(config, streamResolution, countback);
  if (candles.length === 0) {
    logWarn("O1_CANDLE_POLL", "REST poll returned no candles", {
      streamResolution,
      countback,
    });
    return { fetchedCount: 0, ingestedCount: 0, latestTs: lastIngestedTs, closedDetected: false };
  }

  if (lastIngestedTs === null) {
    const baselineTs = Number(candles[candles.length - 1]![0]);
    logInfo("O1_CANDLE_POLL", "REST poll baseline established", {
      streamResolution,
      baselineTs,
      fetchedCount: candles.length,
    });
    return {
      fetchedCount: candles.length,
      ingestedCount: 0,
      latestTs: baselineTs,
      closedDetected: false,
    };
  }

  let ingestedCount = 0;
  let latestTs = lastIngestedTs;
  let closedDetected = false;

  for (const candle of candles) {
    const ts = Number(candle[0]);
    if (!Number.isFinite(ts)) continue;
    if (lastIngestedTs !== null && ts < lastIngestedTs) continue;
    if (lastIngestedTs !== null && ts === lastIngestedTs) {
      onCandle(candle);
      ingestedCount += 1;
      latestTs = ts;
      continue;
    }
    if (lastIngestedTs !== null && ts > lastIngestedTs) {
      closedDetected = true;
    }
    onCandle(candle);
    ingestedCount += 1;
    latestTs = ts;
  }

  logInfo("O1_CANDLE_POLL", "REST candle poll ingested", {
    streamResolution,
    fetchedCount: candles.length,
    ingestedCount,
    latestTs,
    closedDetected,
    lastIngestedTs,
  });

  logDebug("O1_CANDLE_POLL", "REST poll snapshot", {
    firstTs: Number(candles[0]?.[0] ?? 0),
    lastTs: Number(candles[candles.length - 1]?.[0] ?? 0),
  });

  return {
    fetchedCount: candles.length,
    ingestedCount,
    latestTs: latestTs ?? (candles.length > 0 ? Number(candles[candles.length - 1]![0]) : null),
    closedDetected,
  };
};
