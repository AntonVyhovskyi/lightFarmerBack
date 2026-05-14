import type { O1Candle } from "./types";

export const upsertCandle = (candles: O1Candle[], candle: O1Candle, maxSize: number): void => {
  const ts = Number(candle[0]);
  const existingIdx = candles.findIndex((entry) => Number(entry[0]) === ts);
  if (existingIdx >= 0) candles[existingIdx] = candle;
  else candles.push(candle);

  candles.sort((a, b) => Number(a[0]) - Number(b[0]));
  if (candles.length > maxSize) candles.splice(0, candles.length - maxSize);
};
