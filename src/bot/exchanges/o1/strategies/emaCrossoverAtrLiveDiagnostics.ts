import { ATR, EMA } from "technicalindicators";
import { logInfo, roundMetric } from "../logger";
import type { O1Candle, O1EmaCrossoverAtrLiveParams, O1State } from "../types";
import { computeStrengthPct } from "./strengthPct";
import { EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME } from "./types";

export type EmaCrossoverAtrLiveTickSnapshot = {
  latestCandleTs: number | null;
  closedCandleTs: number | null;
  candleClose: number | null;
  emaShort: number | null;
  emaLong: number | null;
  atr: number | null;
  crossover: "long" | "short" | "none";
  strengthPct: number | null;
  positionSize: number;
  breakEvenActive: boolean;
  trailingActive: boolean;
  indicatorsReady: boolean;
  closedCandleCount: number;
  requiredCandles: number;
};

const getClosedCandles = (state: O1State, closedCandleTs: number): O1Candle[] => {
  return state.candles.filter((candle) => Number(candle[0]) <= closedCandleTs);
};

export const buildEmaCrossoverAtrLiveTickSnapshot = (
  state: O1State,
  closedCandleTs: number,
  params: O1EmaCrossoverAtrLiveParams
): EmaCrossoverAtrLiveTickSnapshot => {
  const latestCandleTs = state.candles.length > 0 ? Number(state.candles[state.candles.length - 1]?.[0]) : null;
  const closedCandles = getClosedCandles(state, closedCandleTs);
  const requiredCandles = Math.max(params.emaLongPeriod, params.atrPeriod) + 2;

  const base: EmaCrossoverAtrLiveTickSnapshot = {
    latestCandleTs,
    closedCandleTs,
    candleClose: null,
    emaShort: null,
    emaLong: null,
    atr: null,
    crossover: "none",
    strengthPct: null,
    positionSize: state.positionSize,
    breakEvenActive: state.strategy.breakEvenActive,
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
  const emaShortSeries = EMA.calculate({ values: closes, period: params.emaShortPeriod });
  const emaLongSeries = EMA.calculate({ values: closes, period: params.emaLongPeriod });
  const atrSeries = ATR.calculate({ high: highs, low: lows, close: closes, period: params.atrPeriod });

  if (emaShortSeries.length < 2 || emaLongSeries.length < 2 || atrSeries.length < 1) return base;

  const emaShort = emaShortSeries[emaShortSeries.length - 1]!;
  const emaLong = emaLongSeries[emaLongSeries.length - 1]!;
  const prevEmaShort = emaShortSeries[emaShortSeries.length - 2]!;
  const prevEmaLong = emaLongSeries[emaLongSeries.length - 2]!;
  const atr = atrSeries[atrSeries.length - 1]!;
  const close = closes[closes.length - 1]!;

  const crossedLong = prevEmaShort <= prevEmaLong && emaShort > emaLong;
  const crossedShort = prevEmaShort >= prevEmaLong && emaShort < emaLong;
  const crossover = crossedLong ? "long" : crossedShort ? "short" : "none";
  const strengthPct = crossover === "none"
    ? null
    : computeStrengthPct(crossover, closes, candleTs, params.strengthLookbackCandles).strengthPct;

  return {
    ...base,
    candleClose: close,
    emaShort,
    emaLong,
    atr,
    crossover,
    strengthPct,
  };
};

export const markEmaCrossoverAtrLiveReadyOnce = (state: O1State, snapshot: EmaCrossoverAtrLiveTickSnapshot): void => {
  if (!snapshot.indicatorsReady || state.strategy.indicatorsReadyLogged) return;
  state.strategy.indicatorsReadyLogged = true;
  state.strategy.activeStrategyName = EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME;
  logInfo("O1_STRATEGY_READY", "Indicators warmed up; strategy is active", {
    strategy: EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME,
    closedCandleCount: snapshot.closedCandleCount,
    requiredCandles: snapshot.requiredCandles,
  });
};
