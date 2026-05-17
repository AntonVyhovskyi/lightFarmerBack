import { ATR, EMA } from "technicalindicators";
import { logInfo, roundMetric } from "../logger";
import type { O1Candle, O1EmaAtrTrailStrategyParams, O1State } from "../types";
import { getStrengthPct } from "./strengthPct";

export type EmaAtrTrail3mTickSnapshot = {
  latestCandleTs: number | null;
  closedCandleTs: number | null;
  candleClose: number | null;
  emaShort: number | null;
  emaLong: number | null;
  atr: number | null;
  crossover: "long" | "short" | "none";
  strengthPct: number | null;
  positionSize: number;
  trailingActive: boolean;
  indicatorsReady: boolean;
  closedCandleCount: number;
  requiredCandles: number;
};

const getClosedCandles = (state: O1State, closedCandleTs: number): O1Candle[] => {
  return state.candles.filter((candle) => Number(candle[0]) <= closedCandleTs);
};

export const buildEmaAtrTrail3mTickSnapshot = (
  state: O1State,
  closedCandleTs: number,
  params: O1EmaAtrTrailStrategyParams
): EmaAtrTrail3mTickSnapshot => {
  const latestCandleTs = state.candles.length > 0 ? Number(state.candles[state.candles.length - 1]?.[0]) : null;
  const closedCandles = getClosedCandles(state, closedCandleTs);
  const requiredCandles = Math.max(params.emaLongPeriod, params.atrPeriod) + 2;

  const base: EmaAtrTrail3mTickSnapshot = {
    latestCandleTs,
    closedCandleTs,
    candleClose: null,
    emaShort: null,
    emaLong: null,
    atr: null,
    crossover: "none",
    strengthPct: null,
    positionSize: state.positionSize,
    trailingActive: state.strategy.trailingActive,
    indicatorsReady: closedCandles.length >= requiredCandles,
    closedCandleCount: closedCandles.length,
    requiredCandles,
  };

  if (!base.indicatorsReady) return base;

  const closes = closedCandles.map((candle) => Number(candle[4]));
  const candleTs = closedCandles.map((candle) => Number(candle[0]));
  const highs = closedCandles.map((candle) => Number(candle[2]));
  const lows = closedCandles.map((candle) => Number(candle[3]));
  const ema7Series = EMA.calculate({ values: closes, period: params.emaShortPeriod });
  const ema25Series = EMA.calculate({ values: closes, period: params.emaLongPeriod });
  const atrSeries = ATR.calculate({ high: highs, low: lows, close: closes, period: params.atrPeriod });

  if (ema7Series.length < 2 || ema25Series.length < 2 || atrSeries.length < 1) return base;

  const ema7 = ema7Series[ema7Series.length - 1]!;
  const ema25 = ema25Series[ema25Series.length - 1]!;
  const prevEma7 = ema7Series[ema7Series.length - 2]!;
  const prevEma25 = ema25Series[ema25Series.length - 2]!;
  const atr = atrSeries[atrSeries.length - 1]!;
  const close = closes[closes.length - 1]!;

  const crossedLong = prevEma7 <= prevEma25 && ema7 > ema25;
  const crossedShort = prevEma7 >= prevEma25 && ema7 < ema25;
  const crossover = crossedLong ? "long" : crossedShort ? "short" : "none";
  const strengthPct = crossover === "none" ? null : getStrengthPct(crossover, closes, params, candleTs);

  return {
    ...base,
    candleClose: close,
    emaShort: ema7,
    emaLong: ema25,
    atr,
    crossover,
    strengthPct,
  };
};

export const logEmaAtrTrail3mTick = (snapshot: EmaAtrTrail3mTickSnapshot, effectiveResolution: string): void => {
  logInfo("O1_STRATEGY_TICK", "Closed candle evaluated", {
    effectiveResolution,
    closedCandleTs: snapshot.closedCandleTs,
    close: roundMetric(snapshot.candleClose),
    emaShort: roundMetric(snapshot.emaShort),
    emaLong: roundMetric(snapshot.emaLong),
    atr: roundMetric(snapshot.atr),
    crossover: snapshot.crossover,
    strengthPct: roundMetric(snapshot.strengthPct),
    positionSize: snapshot.positionSize,
    trailingActive: snapshot.trailingActive,
  });
};

export const markStrategyReadyOnce = (state: O1State, snapshot: EmaAtrTrail3mTickSnapshot): void => {
  if (!snapshot.indicatorsReady || state.strategy.indicatorsReadyLogged) return;
  state.strategy.indicatorsReadyLogged = true;
  logInfo("O1_STRATEGY_READY", "Indicators warmed up; strategy is active", {
    closedCandleCount: snapshot.closedCandleCount,
    requiredCandles: snapshot.requiredCandles,
    emaShort: roundMetric(snapshot.emaShort),
    emaLong: roundMetric(snapshot.emaLong),
    atr: roundMetric(snapshot.atr),
  });
};
