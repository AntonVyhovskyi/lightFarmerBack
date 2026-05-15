import type { O1Candle } from "./types";

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
