import type { O1Candle } from "./types";
import { upsertCandle } from "./candleCache";

export const THREE_MINUTE_MS = 3 * 60 * 1000;

export const alignTo3mBucketMs = (openMs: number): number => {
  const date = new Date(openMs);
  const alignedMinute = date.getUTCMinutes() - (date.getUTCMinutes() % 3);
  date.setUTCMinutes(alignedMinute, 0, 0);
  return date.getTime();
};

export const describeCandleAlignment = (sourceOpenMs: number) => {
  const bucketKeyMs = alignTo3mBucketMs(sourceOpenMs);
  const sourceDate = new Date(sourceOpenMs);
  const aggregatedDate = new Date(bucketKeyMs);
  return {
    sourceOpenMs,
    sourceMinuteUtc: sourceDate.getUTCMinutes(),
    sourceMinuteMod3: sourceDate.getUTCMinutes() % 3,
    bucketKeyMs,
    aggregatedMinuteUtc: aggregatedDate.getUTCMinutes(),
    aggregatedMinuteMod3: aggregatedDate.getUTCMinutes() % 3,
    bucketAligned: aggregatedDate.getUTCMinutes() % 3 === 0,
  };
};

export const count1mBarsInBucket = (oneMinuteCandles: O1Candle[], bucketKeyMs: number): number => {
  return oneMinuteCandles.filter((candle) => alignTo3mBucketMs(Number(candle[0])) === bucketKeyMs).length;
};

export const detectClosed3mBucketMs = (
  oneMinuteCandles: O1Candle[],
  previousLatest1mTs: number | null,
  currentLatest1mTs: number
): number | null => {
  if (previousLatest1mTs === null) return null;

  const previousBucket = alignTo3mBucketMs(previousLatest1mTs);
  const currentBucket = alignTo3mBucketMs(currentLatest1mTs);
  if (currentBucket <= previousBucket) return null;

  const barsInClosedBucket = count1mBarsInBucket(oneMinuteCandles, previousBucket);
  if (barsInClosedBucket < 3) return null;

  return previousBucket;
};

const build3mCandleFromBars = (bucketStart: number, bars: O1Candle[]): O1Candle => {
  const ordered = [...bars].sort((left, right) => Number(left[0]) - Number(right[0]));
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
  ];
};

export const aggregateBucket1mTo3m = (oneMinuteCandles: O1Candle[], bucketKeyMs: number): O1Candle | null => {
  const bars = oneMinuteCandles.filter((candle) => alignTo3mBucketMs(Number(candle[0])) === bucketKeyMs);
  if (bars.length === 0) return null;
  return build3mCandleFromBars(bucketKeyMs, bars);
};

export type Live3mMergeResult = {
  latestLive3mBucketTs: number | null;
  mergedBucketKeys: number[];
  formingBucketBarCount: number;
};

/** Merge live 1m-derived 3m buckets into preloaded effective cache (does not replace history). */
export const mergeLive1mIntoEffective3mCache = (
  effectiveCache: O1Candle[],
  oneMinuteCandles: O1Candle[],
  maxSize: number
): Live3mMergeResult => {
  if (oneMinuteCandles.length === 0) {
    return { latestLive3mBucketTs: null, mergedBucketKeys: [], formingBucketBarCount: 0 };
  }

  const latest1mTs = Number(oneMinuteCandles[oneMinuteCandles.length - 1]![0]);
  const latestLive3mBucketTs = alignTo3mBucketMs(latest1mTs);
  const formingBucketBarCount = count1mBarsInBucket(oneMinuteCandles, latestLive3mBucketTs);
  const mergedBucketKeys: number[] = [];

  const formingCandle = aggregateBucket1mTo3m(oneMinuteCandles, latestLive3mBucketTs);
  if (formingCandle) {
    upsertCandle(effectiveCache, formingCandle, maxSize);
    mergedBucketKeys.push(latestLive3mBucketTs);
  }

  const completeLiveBuckets = aggregate1mCandlesTo3m(oneMinuteCandles);
  for (const candle of completeLiveBuckets) {
    const bucketKey = Number(candle[0]);
    if (bucketKey === latestLive3mBucketTs) continue;
    upsertCandle(effectiveCache, candle, maxSize);
    mergedBucketKeys.push(bucketKey);
  }

  return {
    latestLive3mBucketTs,
    mergedBucketKeys: [...new Set(mergedBucketKeys)].sort((left, right) => left - right),
    formingBucketBarCount,
  };
};

export const aggregate1mCandlesTo3m = (oneMinuteCandles: O1Candle[]): O1Candle[] => {
  if (oneMinuteCandles.length === 0) return [];

  const sorted = [...oneMinuteCandles].sort((left, right) => Number(left[0]) - Number(right[0]));
  const grouped = new Map<number, O1Candle[]>();

  for (const candle of sorted) {
    const openMs = Number(candle[0]);
    if (!Number.isFinite(openMs)) continue;
    const bucketStart = alignTo3mBucketMs(openMs);
    const bucket = grouped.get(bucketStart) ?? [];
    bucket.push(candle);
    grouped.set(bucketStart, bucket);
  }

  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketStart, bars]) => {
      if (bars.length < 3) return null;
      return build3mCandleFromBars(bucketStart, bars);
    })
    .filter((candle): candle is O1Candle => candle !== null);
};
