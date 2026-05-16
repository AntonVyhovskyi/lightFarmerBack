import { logInfo, roundMetric } from "./logger";
import type { O1State } from "./types";
import type { EmaAtrTrail3mTickSnapshot } from "./strategies/emaAtrTrail3mDiagnostics";

export const hasStalePositionStrategyState = (state: O1State): boolean => {
  const strategy = state.strategy;
  return (
    strategy.activeStopLossSpec !== null ||
    strategy.currentStopLoss !== null ||
    strategy.lastEntryPrice !== null ||
    strategy.trailingActive ||
    strategy.lastTrailingUpdateCandleTs !== null
  );
};

export const clearPositionLinkedStrategyState = (state: O1State): void => {
  const strategy = state.strategy;
  strategy.activeStopLossSpec = null;
  strategy.currentStopLoss = null;
  strategy.lastEntryPrice = null;
  strategy.trailingActive = false;
  strategy.lastTrailingUpdateCandleTs = null;
  state.trailingActive = false;
};

export const seedStrategyDiagnosticsFromSnapshot = (
  state: O1State,
  snapshot: EmaAtrTrail3mTickSnapshot,
  closedCandleTs: number
): void => {
  const strategy = state.strategy;
  if (!snapshot.indicatorsReady) return;
  if (snapshot.emaShort !== null) strategy.lastEma7 = snapshot.emaShort;
  if (snapshot.emaLong !== null) strategy.lastEma25 = snapshot.emaLong;
  if (snapshot.atr !== null) strategy.lastAtr = snapshot.atr;
  if (strategy.lastSignalReason === "not-started") {
    strategy.lastSignalReason = "preloaded-indicators-ready";
    strategy.lastSignal = "none";
  }
  logInfo("O1_STRATEGY_STATE_UPDATE", "Seeded strategy diagnostics from preload", {
    closedCandleTs,
    emaShort: roundMetric(strategy.lastEma7),
    emaLong: roundMetric(strategy.lastEma25),
    atr: roundMetric(strategy.lastAtr),
    lastSignalReason: strategy.lastSignalReason,
  });
};

export const logStrategyStateUpdate = (state: O1State, closedCandleTs: number): void => {
  const strategy = state.strategy;
  logInfo("O1_STRATEGY_STATE_UPDATE", "Strategy diagnostics updated", {
    closedCandleTs,
    lastProcessedCandleTs: strategy.lastProcessedCandleTs,
    lastSignal: strategy.lastSignal,
    lastSignalReason: strategy.lastSignalReason,
    emaShort: roundMetric(strategy.lastEma7),
    emaLong: roundMetric(strategy.lastEma25),
    atr: roundMetric(strategy.lastAtr),
    strengthPct: roundMetric(strategy.lastStrengthPct),
    currentStopLoss: roundMetric(strategy.currentStopLoss),
    trailingActive: strategy.trailingActive,
    positionSize: state.positionSize,
  });
};

export const logStrategyTickFromState = (state: O1State, effectiveResolution: string, closedCandleTs: number): void => {
  const strategy = state.strategy;
  logInfo("O1_STRATEGY_TICK", "Closed candle evaluated", {
    effectiveResolution,
    closedCandleTs,
    lastProcessedCandleTs: strategy.lastProcessedCandleTs,
    emaShort: roundMetric(strategy.lastEma7),
    emaLong: roundMetric(strategy.lastEma25),
    atr: roundMetric(strategy.lastAtr),
    lastSignal: strategy.lastSignal,
    lastSignalReason: strategy.lastSignalReason,
    strengthPct: roundMetric(strategy.lastStrengthPct),
    positionSize: state.positionSize,
    trailingActive: strategy.trailingActive,
  });
};
