/** Detect closed candle on direct resolution streams when open time advances. */
export const detectDirectClosedCandleTs = (
  previousLatestTs: number | null,
  currentTs: number
): number | null => {
  if (previousLatestTs === null) return null;
  if (!Number.isFinite(previousLatestTs) || !Number.isFinite(currentTs)) return null;
  return currentTs > previousLatestTs ? previousLatestTs : null;
};
