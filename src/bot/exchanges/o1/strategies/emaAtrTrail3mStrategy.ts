import { ATR, EMA } from "technicalindicators";
import { Side, TriggerKind } from "@n1xyz/nord-ts";
import { o1Error, o1Log } from "../logger";
import type { O1Candle, O1State, O1TriggerSpec } from "../types";
import { EMA_ATR_TRAIL_3M_STRATEGY_NAME } from "./types";

export const EMA_ATR_TRAIL_3M_PARAMS = {
  emaShortPeriod: 7,
  emaLongPeriod: 25,
  atrPeriod: 14,
  strengthConfirmationPct: 0.5,
  riskPct: 1,
  atrStopMultiplier: 2.5,
  trailingStartPct: 1,
  trailingGapPct: 0.5,
  leverage: 7,
  timeframe: "3m",
  strengthLookback: 5,
} as const;

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
};

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const getClosedCandles = (state: O1State, closedCandleTs: number): O1Candle[] => {
  return state.candles.filter((candle) => Number(candle[0]) <= closedCandleTs);
};

const getCloses = (candles: O1Candle[]): number[] => candles.map((candle) => Number(candle[4]));

const getStrengthPct = (side: "long" | "short", closes: number[]): number | null => {
  if (closes.length < EMA_ATR_TRAIL_3M_PARAMS.strengthLookback) return null;
  const recent = closes.slice(-EMA_ATR_TRAIL_3M_PARAMS.strengthLookback);
  const currentClose = recent[recent.length - 1]!;
  if (!Number.isFinite(currentClose) || currentClose <= 0) return null;
  if (side === "long") {
    const highest = Math.max(...recent);
    return ((highest - currentClose) / currentClose) * 100;
  }
  const lowest = Math.min(...recent);
  return ((currentClose - lowest) / currentClose) * 100;
};

const calculatePositionSize = (balance: number, entryPrice: number, atr: number, maxPositionSize: number, sizeDecimals: number): number => {
  const stopDistance = atr * EMA_ATR_TRAIL_3M_PARAMS.atrStopMultiplier;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || entryPrice <= 0) return 0;
  const riskBudget = balance * (EMA_ATR_TRAIL_3M_PARAMS.riskPct / 100);
  const sizeByRisk = riskBudget / stopDistance;
  const maxSizeByLeverage = (balance * EMA_ATR_TRAIL_3M_PARAMS.leverage) / entryPrice;
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
}: EmaAtrTrail3mInput): EmaAtrTrail3mAction => {
  const diagnostics = state.strategy;
  diagnostics.activeStrategyName = EMA_ATR_TRAIL_3M_STRATEGY_NAME;

  if (diagnostics.lastProcessedCandleTs === closedCandleTs) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "duplicate-closed-candle";
    o1Log("O1_STRATEGY_SKIP", "Closed candle already processed.", { closedCandleTs });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closedCandles = getClosedCandles(state, closedCandleTs);
  const minBars = Math.max(EMA_ATR_TRAIL_3M_PARAMS.emaLongPeriod, EMA_ATR_TRAIL_3M_PARAMS.atrPeriod) + 2;
  if (closedCandles.length < minBars) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "insufficient-closed-candles";
    o1Log("O1_STRATEGY_SKIP", "Not enough closed candles for indicators.", {
      closedCandles: closedCandles.length,
      required: minBars,
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const closes = getCloses(closedCandles);
  const highs = closedCandles.map((candle) => Number(candle[2]));
  const lows = closedCandles.map((candle) => Number(candle[3]));
  const ema7Series = EMA.calculate({ values: closes, period: EMA_ATR_TRAIL_3M_PARAMS.emaShortPeriod });
  const ema25Series = EMA.calculate({ values: closes, period: EMA_ATR_TRAIL_3M_PARAMS.emaLongPeriod });
  const atrSeries = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: EMA_ATR_TRAIL_3M_PARAMS.atrPeriod,
  });

  if (ema7Series.length < 2 || ema25Series.length < 2 || atrSeries.length < 1) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "indicator-warmup-incomplete";
    o1Log("O1_STRATEGY_SKIP", "Indicator warmup incomplete.", {
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

  o1Log("O1_STRATEGY_ATR", "Computed ATR for closed candle.", { closedCandleTs, atr, close, ema7, ema25 });

  if (state.positionSize !== 0) {
    const entryPrice = state.entryPrice > 0 ? state.entryPrice : close;
    const isLong = state.positionSize > 0;
    const profitPct = isLong ? ((close - entryPrice) / entryPrice) * 100 : ((entryPrice - close) / entryPrice) * 100;

    if (!diagnostics.trailingActive && profitPct >= EMA_ATR_TRAIL_3M_PARAMS.trailingStartPct) {
      diagnostics.trailingActive = true;
      diagnostics.lastSignal = "trail-active";
      diagnostics.lastSignalReason = "trailing-activated";
      o1Log("O1_STRATEGY_TRAIL_ACTIVE", "Trailing stop activated.", { closedCandleTs, profitPct, entryPrice, close });
    }

    if (diagnostics.trailingActive) {
      const candidateStop = isLong
        ? roundTo(close * (1 - EMA_ATR_TRAIL_3M_PARAMS.trailingGapPct / 100), priceDecimals)
        : roundTo(close * (1 + EMA_ATR_TRAIL_3M_PARAMS.trailingGapPct / 100), priceDecimals);
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
        o1Log("O1_STRATEGY_TRAIL_UPDATE", "Trailing stop moved.", {
          closedCandleTs,
          previousStopLoss: previousStop,
          stopLoss: candidateStop,
          profitPct,
        });
        return { type: "updateTrailStop", stopLoss: candidateStop, previousStopLoss: previousStop ?? candidateStop };
      }

      diagnostics.lastSignal = "none";
      diagnostics.lastSignalReason = "trailing-stop-unchanged";
      o1Log("O1_STRATEGY_SKIP", "Trailing stop candidate did not improve.", {
        closedCandleTs,
        candidateStop,
        previousStop,
      });
      return { type: "none", reason: diagnostics.lastSignalReason };
    }

    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "position-open-awaiting-trail";
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const crossedLong = prevEma7 <= prevEma25 && ema7 > ema25;
  const crossedShort = prevEma7 >= prevEma25 && ema7 < ema25;
  if (!crossedLong && !crossedShort) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "no-ema-cross";
    o1Log("O1_STRATEGY_SKIP", "No EMA cross on closed candle.", { closedCandleTs, ema7, ema25 });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const side = crossedLong ? "long" : "short";
  const strengthPct = getStrengthPct(side, closes);
  diagnostics.lastStrengthPct = strengthPct;
  o1Log("O1_STRATEGY_STRENGTH", "Computed movement strength.", {
    closedCandleTs,
    side,
    strengthPct,
    required: EMA_ATR_TRAIL_3M_PARAMS.strengthConfirmationPct,
  });

  if (strengthPct === null || strengthPct < EMA_ATR_TRAIL_3M_PARAMS.strengthConfirmationPct) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "strength-below-threshold";
    o1Log("O1_STRATEGY_SKIP", "Movement strength below threshold.", {
      closedCandleTs,
      side,
      strengthPct,
      required: EMA_ATR_TRAIL_3M_PARAMS.strengthConfirmationPct,
    });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const entryPrice = close;
  const size = calculatePositionSize(state.balanceTotal, entryPrice, atr, maxPositionSize, sizeDecimals);
  o1Log("O1_STRATEGY_SIZE", "Computed position size.", {
    balanceTotal: state.balanceTotal,
    entryPrice,
    atr,
    stopDistance: atr * EMA_ATR_TRAIL_3M_PARAMS.atrStopMultiplier,
    size,
    riskPct: EMA_ATR_TRAIL_3M_PARAMS.riskPct,
    leverage: EMA_ATR_TRAIL_3M_PARAMS.leverage,
  });

  if (size <= 0) {
    diagnostics.lastSignal = "none";
    diagnostics.lastSignalReason = "invalid-position-size";
    o1Error("O1_STRATEGY_ERROR", "Computed position size is invalid.", { size, entryPrice, atr });
    return { type: "none", reason: diagnostics.lastSignalReason };
  }

  const stopLoss = crossedLong
    ? roundTo(entryPrice - atr * EMA_ATR_TRAIL_3M_PARAMS.atrStopMultiplier, priceDecimals)
    : roundTo(entryPrice + atr * EMA_ATR_TRAIL_3M_PARAMS.atrStopMultiplier, priceDecimals);

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

  o1Log("O1_STRATEGY_SIGNAL", "Entry signal detected.", { closedCandleTs, side, ema7, ema25, strengthPct, stopLoss, size });
  o1Log("O1_STRATEGY_ENTRY", "Prepared entry action.", { side, entryPrice, size, stopLoss });
  o1Log("O1_STRATEGY_INITIAL_SL", "Prepared initial stop-loss.", { stopLoss, size, side: crossedLong ? "ask" : "bid" });

  if (crossedLong) {
    diagnostics.lastSignal = "open-long";
    diagnostics.lastSignalReason = "ema-cross-long";
    return { type: "openLong", size, entryPrice, stopLoss, atr, strengthPct, ema7, ema25 };
  }

  diagnostics.lastSignal = "open-short";
  diagnostics.lastSignalReason = "ema-cross-short";
  return { type: "openShort", size, entryPrice, stopLoss, atr, strengthPct, ema7, ema25 };
};
