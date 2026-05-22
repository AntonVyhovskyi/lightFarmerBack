import { ATR, EMA } from "technicalindicators";
import type { O1Candle, O1EmaCrossoverAtrLiveParams } from "./types";
import { computeStrengthPct } from "./strategies/strengthPct";

export type HistoricalCrossoverEvent = {
  candleTs: number;
  close: number;
  direction: "long" | "short";
  prevEmaShort: number;
  prevEmaLong: number;
  emaShort: number;
  emaLong: number;
  atr: number;
  strengthPct: number | null;
};

export type CrossoverScanSummary = {
  totalCrosses: number;
  longCrosses: number;
  shortCrosses: number;
  scannedCandleCount: number;
  warmupSkippedCount: number;
  candlesLoaded: number;
  firstCandleTs: number | null;
  lastCandleTs: number | null;
  emaShortPeriod: number;
  emaLongPeriod: number;
  atrPeriod: number;
  strengthLookbackCandles: number;
  events: HistoricalCrossoverEvent[];
};

export const scanHistoricalEmaCrossovers = (
  candles: O1Candle[],
  params: Pick<O1EmaCrossoverAtrLiveParams, "emaShortPeriod" | "emaLongPeriod" | "atrPeriod" | "strengthLookbackCandles">
): CrossoverScanSummary => {
  const firstCandleTs = candles.length > 0 ? Number(candles[0]![0]) : null;
  const lastCandleTs = candles.length > 0 ? Number(candles[candles.length - 1]![0]) : null;
  const minBars = Math.max(params.emaLongPeriod, params.atrPeriod) + 2;
  const events: HistoricalCrossoverEvent[] = [];
  let warmupSkippedCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    if (slice.length < minBars) {
      warmupSkippedCount += 1;
      continue;
    }
    const closes = slice.map((c) => Number(c[4]));
    const candleTs = slice.map((c) => Number(c[0]));
    const highs = slice.map((c) => Number(c[2]));
    const lows = slice.map((c) => Number(c[3]));
    const emaShortSeries = EMA.calculate({ values: closes, period: params.emaShortPeriod });
    const emaLongSeries = EMA.calculate({ values: closes, period: params.emaLongPeriod });
    const atrSeries = ATR.calculate({ high: highs, low: lows, close: closes, period: params.atrPeriod });
    if (emaShortSeries.length < 2 || emaLongSeries.length < 2 || atrSeries.length < 1) {
      warmupSkippedCount += 1;
      continue;
    }
    const emaShort = emaShortSeries[emaShortSeries.length - 1]!;
    const emaLong = emaLongSeries[emaLongSeries.length - 1]!;
    const prevEmaShort = emaShortSeries[emaShortSeries.length - 2]!;
    const prevEmaLong = emaLongSeries[emaLongSeries.length - 2]!;
    const atr = atrSeries[atrSeries.length - 1]!;
    const close = closes[closes.length - 1]!;
    const crossedLong = prevEmaShort <= prevEmaLong && emaShort > emaLong;
    const crossedShort = prevEmaShort >= prevEmaLong && emaShort < emaLong;
    if (!crossedLong && !crossedShort) continue;
    const direction = crossedLong ? "long" : "short";
    const strength = computeStrengthPct(direction, closes, candleTs, params.strengthLookbackCandles);
    events.push({
      candleTs: candleTs[candleTs.length - 1]!,
      close,
      direction,
      prevEmaShort,
      prevEmaLong,
      emaShort,
      emaLong,
      atr,
      strengthPct: strength.strengthPct,
    });
  }

  return {
    totalCrosses: events.length,
    longCrosses: events.filter((e) => e.direction === "long").length,
    shortCrosses: events.filter((e) => e.direction === "short").length,
    scannedCandleCount: candles.length,
    warmupSkippedCount,
    candlesLoaded: candles.length,
    firstCandleTs,
    lastCandleTs,
    emaShortPeriod: params.emaShortPeriod,
    emaLongPeriod: params.emaLongPeriod,
    atrPeriod: params.atrPeriod,
    strengthLookbackCandles: params.strengthLookbackCandles,
    events,
  };
};
