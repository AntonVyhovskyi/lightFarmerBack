import type { O1TriggerSpec } from "../types";

export const EMA_ATR_TRAIL_3M_STRATEGY_NAME = "emaAtrTrail3mStrategy";
export const EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME = "emaCrossoverAtrLiveStrategy";
export const CONSERVATIVE_EMA_STRATEGY_NAME = "conservativeEma";

export type O1StrategyDiagnostics = {
  activeStrategyName: string | null;
  lastSignal: string;
  lastSignalReason: string;
  lastEma7: number | null;
  lastEma25: number | null;
  lastAtr: number | null;
  lastStrengthPct: number | null;
  lastEntryPrice: number | null;
  currentStopLoss: number | null;
  breakEvenActive: boolean;
  trailingActive: boolean;
  lastTrailingUpdateCandleTs: number | null;
  lastProcessedCandleTs: number | null;
  activeStopLossSpec: O1TriggerSpec | null;
  indicatorsReadyLogged: boolean;
  cooldownCandlesRemaining: number;
  tradesTodayCount: number;
  lastTradeDayUtc: string | null;
  entryCandleTs: number | null;
};

export const createInitialO1StrategyDiagnostics = (): O1StrategyDiagnostics => ({
  activeStrategyName: null,
  lastSignal: "none",
  lastSignalReason: "not-started",
  lastEma7: null,
  lastEma25: null,
  lastAtr: null,
  lastStrengthPct: null,
  lastEntryPrice: null,
  currentStopLoss: null,
  breakEvenActive: false,
  trailingActive: false,
  lastTrailingUpdateCandleTs: null,
  lastProcessedCandleTs: null,
  activeStopLossSpec: null,
  indicatorsReadyLogged: false,
  cooldownCandlesRemaining: 0,
  tradesTodayCount: 0,
  lastTradeDayUtc: null,
  entryCandleTs: null,
});
