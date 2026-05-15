import type { O1TriggerSpec } from "../types";

export const EMA_ATR_TRAIL_3M_STRATEGY_NAME = "emaAtrTrail3mStrategy";
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
  trailingActive: boolean;
  lastTrailingUpdateCandleTs: number | null;
  lastProcessedCandleTs: number | null;
  activeStopLossSpec: O1TriggerSpec | null;
  indicatorsReadyLogged: boolean;
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
  trailingActive: false,
  lastTrailingUpdateCandleTs: null,
  lastProcessedCandleTs: null,
  activeStopLossSpec: null,
  indicatorsReadyLogged: false,
});
