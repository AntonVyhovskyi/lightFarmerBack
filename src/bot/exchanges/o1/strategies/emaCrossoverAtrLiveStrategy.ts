import { ATR, EMA } from "technicalindicators";
import { Side, TriggerKind } from "@n1xyz/nord-ts";
import { logError, logInfo, roundMetric } from "../logger";
import type { O1Candle, O1EmaCrossoverAtrLiveParams, O1State, O1TriggerSpec } from "../types";
import type { O1CrossoverSnapshot } from "./emaAtrTrail3mStrategy";
import { computeStrengthPct } from "./strengthPct";
import { EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME } from "./types";

export type EmaCrossoverAtrLiveAction =
  | { type: "none"; reason: string; crossover?: O1CrossoverSnapshot }
  | {
      type: "openLong";
      size: number;
      entryPrice: number;
      stopLoss: number;
      crossover?: O1CrossoverSnapshot;
    }
  | {
      type: "openShort";
      size: number;
      entryPrice: number;
      stopLoss: number;
      crossover?: O1CrossoverSnapshot;
    }
  | {
      type: "updateStopLoss";
      stopLoss: number;
      previousStopLoss: number;
      updateKind: "break-even" | "trailing";
    }
  | { type: "closePosition"; reason: string };

export type EmaCrossoverAtrLiveInput = {
  state: O1State;
  closedCandleTs: number;
  marketId: number;
  maxPositionSize: number;
  maxOrderNotional: number;
  priceDecimals: number;
  sizeDecimals: number;
  params: O1EmaCrossoverAtrLiveParams;
};

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const getClosedCandles = (state: O1State, closedCandleTs: number): O1Candle[] => {
  return state.candles.filter((candle) => Number(candle[0]) <= closedCandleTs);
};

const getCloses = (candles: O1Candle[]): number[] => candles.map((candle) => Number(candle[4]));

const getUtcDayKey = (): string => new Date().toISOString().slice(0, 10);

const resetTradesTodayIfNeeded = (state: O1State): void => {
  const dayKey = getUtcDayKey();
  if (state.strategy.lastTradeDayUtc !== dayKey) {
    state.strategy.lastTradeDayUtc = dayKey;
    state.strategy.tradesTodayCount = 0;
  }
};

const calculatePositionSize = (
  balance: number,
  entryPrice: number,
  stopLoss: number,
  maxPositionSize: number,
  maxOrderNotional: number,
  sizeDecimals: number,
  params: O1EmaCrossoverAtrLiveParams
): number => {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || entryPrice <= 0) return 0;
  const riskBudget = balance * (params.riskPct / 100);
  const sizeByRisk = riskBudget / stopDistance;
  const maxSizeByLeverage = (balance * params.leverage) / entryPrice;
  const maxSizeByNotional = maxOrderNotional / entryPrice;
  const rawSize = Math.min(sizeByRisk, maxSizeByLeverage, maxSizeByNotional, maxPositionSize);
  return roundTo(rawSize, sizeDecimals);
};

const buildStopLossSpec = (marketId: number, side: Side, triggerPrice: number, size: number): O1TriggerSpec => ({
  marketId,
  side,
  kind: TriggerKind.StopLoss,
  triggerPrice,
  limitBaseSize: size,
});

const buildCrossoverSnapshot = (
  direction: "long" | "short",
  close: number,
  emaShort: number,
  emaLong: number,
  atr: number,
  strengthPct: number | null,
  strengthDetails: ReturnType<typeof computeStrengthPct>["debug"],
  extras?: { calculatedSize?: number; stopLoss?: number }
): O1CrossoverSnapshot => ({
  direction,
  close,
  emaShort,
  emaLong,
  atr,
  strengthPct,
  strengthDetails,
  ...extras,
});

export const evaluateEmaCrossoverAtrLiveStrategy = ({
  state,
  closedCandleTs,
  marketId,
  maxPositionSize,
  maxOrderNotional,
  priceDecimals,
  sizeDecimals,
  params,
}: EmaCrossoverAtrLiveInput): EmaCrossoverAtrLiveAction => {
  const diagnostics = state.strategy;
  diagnostics.activeStrategyName = EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME;
  resetTradesTodayIfNeeded(state);

  if (diagnostics.cooldownCandlesRemaining > 0) {
    diagnostics.cooldownCandlesRemaining -= 1;
  }

  if (diagnostics.lastProcessedCandleTs === closedCandleTs) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "duplicate-closed-candle";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closedCandles = getClosedCandles(state, closedCandleTs);
  const minBars = Math.max(params.emaLongPeriod, params.atrPeriod) + 2;
  if (closedCandles.length < minBars) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "insufficient-closed-candles";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closes = getCloses(closedCandles);
  const candleTs = closedCandles.map((candle) => Number(candle[0]));
  const highs = closedCandles.map((candle) => Number(candle[2]));
  const lows = closedCandles.map((candle) => Number(candle[3]));
  const emaShortSeries = EMA.calculate({ values: closes, period: params.emaShortPeriod });
  const emaLongSeries = EMA.calculate({ values: closes, period: params.emaLongPeriod });
  const atrSeries = ATR.calculate({ high: highs, low: lows, close: closes, period: params.atrPeriod });

  if (emaShortSeries.length < 2 || emaLongSeries.length < 2 || atrSeries.length < 1) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "indicator-warmup-incomplete";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const emaShort = emaShortSeries[emaShortSeries.length - 1]!;
  const emaLong = emaLongSeries[emaLongSeries.length - 1]!;
  const prevEmaShort = emaShortSeries[emaShortSeries.length - 2]!;
  const prevEmaLong = emaLongSeries[emaLongSeries.length - 2]!;
  const atr = atrSeries[atrSeries.length - 1]!;
  const close = closes[closes.length - 1]!;

  diagnostics.lastEma7 = emaShort;
  diagnostics.lastEma25 = emaLong;
  diagnostics.lastAtr = atr;
  diagnostics.lastProcessedCandleTs = closedCandleTs;

  const forceTrailing = process.env.O1_TRAILING_FORCE_ACTIVE === "true";

  if (state.positionSize !== 0) {
    const entryPrice = state.entryPrice > 0 ? state.entryPrice : close;
    const isLong = state.positionSize > 0;
    const profitPct = isLong
      ? ((close - entryPrice) / entryPrice) * 100
      : ((entryPrice - close) / entryPrice) * 100;

    if (params.maxHoldCandles > 0 && diagnostics.entryCandleTs !== null) {
      const heldCount = closedCandles.filter((c) => Number(c[0]) > diagnostics.entryCandleTs!).length;
      if (heldCount >= params.maxHoldCandles) {
        diagnostics.lastSignal = "close";
        diagnostics.lastSignalReason = "max-hold-candles";
        return { type: "closePosition", reason: diagnostics.lastSignalReason };
      }
    }

    if (params.takeProfitPct > 0 && profitPct >= params.takeProfitPct) {
      diagnostics.lastSignal = "close";
      diagnostics.lastSignalReason = "take-profit";
      return { type: "closePosition", reason: diagnostics.lastSignalReason };
    }

    if (!diagnostics.breakEvenActive && profitPct >= params.breakEvenPct) {
      const beStop = roundTo(entryPrice, priceDecimals);
      const previousStop = diagnostics.currentStopLoss;
      const improves = previousStop === null
        ? true
        : isLong
          ? beStop > previousStop
          : beStop < previousStop;
      if (improves) {
        diagnostics.breakEvenActive = true;
        state.beActive = true;
        diagnostics.currentStopLoss = beStop;
        diagnostics.lastSignal = "break-even";
        diagnostics.lastSignalReason = "break-even-stop";
        return {
          type: "updateStopLoss",
          stopLoss: beStop,
          previousStopLoss: previousStop ?? beStop,
          updateKind: "break-even",
        };
      }
    }

    const trailThresholdMet = forceTrailing || profitPct >= params.trailingStartPct;
    if (trailThresholdMet) {
      if (!diagnostics.trailingActive) {
        diagnostics.trailingActive = true;
        state.trailingActive = true;
      }
      const candidateStop = isLong
        ? roundTo(close * (1 - params.trailingGapPct / 100), priceDecimals)
        : roundTo(close * (1 + params.trailingGapPct / 100), priceDecimals);
      const previousStop = diagnostics.currentStopLoss;
      const improves = previousStop === null
        ? true
        : isLong
          ? candidateStop > previousStop
          : candidateStop < previousStop;
      if (improves) {
        diagnostics.currentStopLoss = candidateStop;
        diagnostics.lastTrailingUpdateCandleTs = closedCandleTs;
        diagnostics.lastSignal = "trail-update";
        diagnostics.lastSignalReason = "trailing-stop-tightened";
        return {
          type: "updateStopLoss",
          stopLoss: candidateStop,
          previousStopLoss: previousStop ?? candidateStop,
          updateKind: "trailing",
        };
      }
    }

    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "position-open-managing";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  if (process.env.O1_MANAGE_EXISTING_POSITION_ONLY === "true") {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "manage-only-no-new-entries";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const crossedLong = prevEmaShort <= prevEmaLong && emaShort > emaLong;
  const crossedShort = prevEmaShort >= prevEmaLong && emaShort < emaLong;
  if (!crossedLong && !crossedShort) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "no-ema-cross";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const direction = crossedLong ? "long" : "short";
  const strengthCalc = computeStrengthPct(direction, closes, candleTs, params.strengthLookbackCandles);
  diagnostics.lastStrengthPct = strengthCalc.strengthPct;

  const minStopDistance = close * (params.minStopDistancePct / 100);
  const stopDistanceRaw = Math.max(atr * params.atrStopMultiplier, minStopDistance);
  const stopLoss = crossedLong
    ? roundTo(close - stopDistanceRaw, priceDecimals)
    : roundTo(close + stopDistanceRaw, priceDecimals);
  const stopDistance = Math.abs(close - stopLoss);
  const crossoverBase = buildCrossoverSnapshot(
    direction,
    close,
    emaShort,
    emaLong,
    atr,
    strengthCalc.strengthPct,
    strengthCalc.debug
  );

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "invalid-stop-distance";
    return { type: "none", reason: diagnostics.lastSignalReason, crossover: crossoverBase };
  }

  const minMove = close * params.feeRate * params.minMoveVsFeeMult;
  if (stopDistance < minMove) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "fee-below-minimum";
    return { type: "none", reason: diagnostics.lastSignalReason, crossover: crossoverBase };
  }

  if (diagnostics.cooldownCandlesRemaining > 0) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "cooldown-active";
    return { type: "none", reason: diagnostics.lastSignalReason, crossover: crossoverBase };
  }

  if (diagnostics.tradesTodayCount >= params.maxTradesPerDay) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "max-trades-per-day";
    return { type: "none", reason: diagnostics.lastSignalReason, crossover: crossoverBase };
  }

  const size = calculatePositionSize(
    state.balanceTotal,
    close,
    stopLoss,
    maxPositionSize,
    maxOrderNotional,
    sizeDecimals,
    params
  );
  if (size <= 0) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "invalid-position-size";
    return {
      type: "none",
      reason: diagnostics.lastSignalReason,
      crossover: buildCrossoverSnapshot(direction, close, emaShort, emaLong, atr, strengthCalc.strengthPct, strengthCalc.debug, {
        calculatedSize: size,
        stopLoss,
      }),
    };
  }

  diagnostics.lastEntryPrice = close;
  diagnostics.currentStopLoss = stopLoss;
  diagnostics.trailingActive = false;
  diagnostics.breakEvenActive = false;
  diagnostics.lastTrailingUpdateCandleTs = null;
  diagnostics.entryCandleTs = closedCandleTs;
  state.trailingActive = false;
  state.beActive = false;
  diagnostics.activeStopLossSpec = buildStopLossSpec(
    marketId,
    crossedLong ? Side.Ask : Side.Bid,
    stopLoss,
    size
  );

  const crossoverSignal = buildCrossoverSnapshot(
    direction,
    close,
    emaShort,
    emaLong,
    atr,
    strengthCalc.strengthPct,
    strengthCalc.debug,
    { calculatedSize: size, stopLoss }
  );

  if (crossedLong) {
    diagnostics.lastSignal = "open-long";
    diagnostics.lastSignalReason = "ema-cross-long";
    return { type: "openLong", size, entryPrice: close, stopLoss, crossover: crossoverSignal };
  }

  diagnostics.lastSignal = "open-short";
  diagnostics.lastSignalReason = "ema-cross-short";
  return { type: "openShort", size, entryPrice: close, stopLoss, crossover: crossoverSignal };
};
