import { ATR, EMA } from "technicalindicators";
import { Side, TriggerKind } from "@n1xyz/nord-ts";
import { logDebug, logError, logInfo, roundMetric } from "../logger";
import type { O1Candle, O1EmaAtrTrailStrategyParams, O1State, O1TriggerSpec } from "../types";
import { EMA_ATR_TRAIL_3M_STRATEGY_NAME } from "./types";

export type EmaAtrTrail3mAction =
  | { type: "none"; reason: string }
  | {
      type: "openLong";
      size: number;
      entryPrice: number;
      stopLoss: number;
      atr: number;
      strengthPct: number;
      ema7: number;
      ema25: number;
    }
  | {
      type: "openShort";
      size: number;
      entryPrice: number;
      stopLoss: number;
      atr: number;
      strengthPct: number;
      ema7: number;
      ema25: number;
    }
  | {
      type: "updateTrailStop";
      stopLoss: number;
      previousStopLoss: number;
    };

export type EmaAtrTrail3mInput = {
  state: O1State;
  closedCandleTs: number;
  marketId: number;
  maxPositionSize: number;
  priceDecimals: number;
  sizeDecimals: number;
  params: O1EmaAtrTrailStrategyParams;
};

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const getClosedCandles = (state: O1State, closedCandleTs: number): O1Candle[] => {
  return state.candles.filter((candle) => Number(candle[0]) <= closedCandleTs);
};

const getCloses = (candles: O1Candle[]): number[] => candles.map((candle) => Number(candle[4]));

const getStrengthPct = (
  side: "long" | "short",
  closes: number[],
  params: O1EmaAtrTrailStrategyParams
): number | null => {
  if (closes.length < params.strengthLookbackCandles) return null;
  const recent = closes.slice(-params.strengthLookbackCandles);
  const currentClose = recent[recent.length - 1]!;
  if (!Number.isFinite(currentClose) || currentClose <= 0) return null;
  if (side === "long") {
    const highest = Math.max(...recent);
    return ((highest - currentClose) / currentClose) * 100;
  }
  const lowest = Math.min(...recent);
  return ((currentClose - lowest) / currentClose) * 100;
};

const calculatePositionSize = (
  balance: number,
  entryPrice: number,
  atr: number,
  maxPositionSize: number,
  sizeDecimals: number,
  params: O1EmaAtrTrailStrategyParams
): number => {
  const stopDistance = atr * params.atrStopMultiplier;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || entryPrice <= 0) return 0;
  const riskBudget = balance * (params.riskPct / 100);
  const sizeByRisk = riskBudget / stopDistance;
  const maxSizeByLeverage = (balance * params.leverage) / entryPrice;
  const rawSize = Math.min(sizeByRisk, maxSizeByLeverage, maxPositionSize);
  return roundTo(rawSize, sizeDecimals);
};

const buildStopLossSpec = (marketId: number, side: Side, triggerPrice: number, size: number): O1TriggerSpec => ({
  marketId,
  side,
  kind: TriggerKind.StopLoss,
  triggerPrice,
  limitBaseSize: size,
});

export const evaluateEmaAtrTrail3mStrategy = ({
  state,
  closedCandleTs,
  marketId,
  maxPositionSize,
  priceDecimals,
  sizeDecimals,
  params,
}: EmaAtrTrail3mInput): EmaAtrTrail3mAction => {
  const diagnostics = state.strategy;
  diagnostics.activeStrategyName = EMA_ATR_TRAIL_3M_STRATEGY_NAME;

  if (diagnostics.lastProcessedCandleTs === closedCandleTs) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "duplicate-closed-candle";
    logDebug("O1_STRATEGY_SKIP", "Closed candle already processed", { closedCandleTs });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closedCandles = getClosedCandles(state, closedCandleTs);
  const minBars = Math.max(params.emaLongPeriod, params.atrPeriod) + 2;
  if (closedCandles.length < minBars) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "insufficient-closed-candles";
    logDebug("O1_STRATEGY_SKIP", "Not enough closed candles for indicators", {
      closedCandles: closedCandles.length,
      required: minBars,
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closes = getCloses(closedCandles);
  const highs = closedCandles.map((candle) => Number(candle[2]));
  const lows = closedCandles.map((candle) => Number(candle[3]));
  const ema7Series = EMA.calculate({ values: closes, period: params.emaShortPeriod });
  const ema25Series = EMA.calculate({ values: closes, period: params.emaLongPeriod });
  const atrSeries = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: params.atrPeriod,
  });

  if (ema7Series.length < 2 || ema25Series.length < 2 || atrSeries.length < 1) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "indicator-warmup-incomplete";
    logDebug("O1_STRATEGY_SKIP", "Indicator warmup incomplete", {
      ema7: ema7Series.length,
      ema25: ema25Series.length,
      atr: atrSeries.length,
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const ema7 = ema7Series[ema7Series.length - 1]!;
  const ema25 = ema25Series[ema25Series.length - 1]!;
  const prevEma7 = ema7Series[ema7Series.length - 2]!;
  const prevEma25 = ema25Series[ema25Series.length - 2]!;
  const atr = atrSeries[atrSeries.length - 1]!;
  const close = closes[closes.length - 1]!;

  diagnostics.lastEma7 = ema7;
  diagnostics.lastEma25 = ema25;
  diagnostics.lastAtr = atr;
  diagnostics.lastProcessedCandleTs = closedCandleTs;

  logDebug("O1_INDICATORS", "Indicator snapshot", {
    closedCandleTs,
    atr: roundMetric(atr),
    emaShort: roundMetric(ema7),
    emaLong: roundMetric(ema25),
    close: roundMetric(close),
  });

  if (state.positionSize !== 0) {
    const entryPrice = state.entryPrice > 0 ? state.entryPrice : close;
    const isLong = state.positionSize > 0;
    const profitPct = isLong ? ((close - entryPrice) / entryPrice) * 100 : ((entryPrice - close) / entryPrice) * 100;

    if (!diagnostics.trailingActive && profitPct >= params.trailingStartPct) {
      diagnostics.trailingActive = true;
      diagnostics.lastSignal = "trail-active";
      diagnostics.lastSignalReason = "trailing-activated";
      logInfo("O1_TRAIL", "Trailing stop activated", {
        closedCandleTs,
        profitPct: roundMetric(profitPct),
        entryPrice: roundMetric(entryPrice),
        close: roundMetric(close),
      });
    }

    if (diagnostics.trailingActive) {
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
        logInfo("O1_TRAIL", "Trailing stop updated", {
          oldSL: roundMetric(previousStop),
          newSL: roundMetric(candidateStop),
          profitPct: roundMetric(profitPct),
        });
        return { type: "updateTrailStop", stopLoss: candidateStop, previousStopLoss: previousStop ?? candidateStop };
      }

      diagnostics.lastSignal = "none";
      diagnostics.lastSignalReason = "trailing-stop-unchanged";
      logDebug("O1_STRATEGY_SKIP", "Trailing stop candidate did not improve", {
        candidateStop,
        previousStop,
      });
      return { type: "none", reason: diagnostics.lastSignalReason };
    }

    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "position-open-awaiting-trail";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  if (process.env.O1_MANAGE_EXISTING_POSITION_ONLY === "true") {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "manage-only-no-new-entries";
    logDebug("O1_STRATEGY_SKIP", "Entry path skipped in manage-existing-position-only mode", { closedCandleTs });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const crossedLong = prevEma7 <= prevEma25 && ema7 > ema25;
  const crossedShort = prevEma7 >= prevEma25 && ema7 < ema25;
  if (!crossedLong && !crossedShort) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "no-ema-cross";
    logDebug("O1_STRATEGY_SKIP", "No EMA cross on closed candle", {
      emaShort: roundMetric(ema7),
      emaLong: roundMetric(ema25),
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const side = crossedLong ? "long" : "short";
  const strengthPct = getStrengthPct(side, closes, params);
  diagnostics.lastStrengthPct = strengthPct;

  if (strengthPct === null || strengthPct < params.strengthConfirmationPct) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "strength-below-threshold";
    logDebug("O1_STRATEGY_SKIP", "Movement strength below threshold", {
      side,
      strengthPct: roundMetric(strengthPct),
      required: params.strengthConfirmationPct,
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const entryPrice = close;
  const stopDistance = atr * params.atrStopMultiplier;
  const size = calculatePositionSize(state.balanceTotal, entryPrice, atr, maxPositionSize, sizeDecimals, params);

  logInfo("O1_RISK", "Position sizing calculated", {
    balance: roundMetric(state.balanceTotal),
    riskPct: params.riskPct,
    stopDistance: roundMetric(stopDistance),
    size: roundMetric(size),
    atr: roundMetric(atr),
  });

  if (size <= 0) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "invalid-position-size";
    logError("O1_STRATEGY_ERROR", "Computed position size is invalid", { size, entryPrice, atr });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const stopLoss = crossedLong
    ? roundTo(entryPrice - atr * params.atrStopMultiplier, priceDecimals)
    : roundTo(entryPrice + atr * params.atrStopMultiplier, priceDecimals);

  diagnostics.lastEntryPrice = entryPrice;
  diagnostics.currentStopLoss = stopLoss;
  diagnostics.trailingActive = false;
  diagnostics.lastTrailingUpdateCandleTs = null;
  diagnostics.activeStopLossSpec = buildStopLossSpec(
    marketId,
    crossedLong ? Side.Ask : Side.Bid,
    stopLoss,
    size
  );

  const signalMessage = crossedLong ? "Long crossover confirmed" : "Short crossover confirmed";
  logInfo("O1_SIGNAL", signalMessage, {
    emaShort: roundMetric(ema7),
    emaLong: roundMetric(ema25),
    strengthPct: roundMetric(strengthPct),
    stopLoss: roundMetric(stopLoss),
    size: roundMetric(size),
    side,
  });

  if (crossedLong) {
    diagnostics.lastSignal = "open-long";
    diagnostics.lastSignalReason = "ema-cross-long";
    return { type: "openLong", size, entryPrice, stopLoss, atr, strengthPct, ema7, ema25 };
  }

  diagnostics.lastSignal = "open-short";
  diagnostics.lastSignalReason = "ema-cross-short";
  return { type: "openShort", size, entryPrice, stopLoss, atr, strengthPct, ema7, ema25 };
};
