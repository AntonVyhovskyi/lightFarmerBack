import type { O1CandleHandling } from "../candleResolution";
import type { O1EmaAtrTrailStrategyParams, O1EnvConfig, O1State } from "../types";
import type { O1CrossoverSnapshot } from "../strategies/emaAtrTrail3mStrategy";
import { recordCrossover } from "./crossoverCache";
import { mapStrategyReasonToCrossoverReason } from "./crossoverReason";
import type { O1CrossoverReason, O1CrossoverRecord } from "./types";

export const buildCrossoverRecordInput = (
  bot: {
    state: O1State;
    config: O1EnvConfig;
    candleHandling: O1CandleHandling;
  },
  closedCandleTs: number,
  snapshot: O1CrossoverSnapshot,
  reason: O1CrossoverReason,
  details: Record<string, unknown>
): Omit<O1CrossoverRecord, "id" | "timestamp"> => ({
  candleTs: closedCandleTs,
  symbol: bot.config.symbol,
  resolution: bot.candleHandling.effectiveResolution,
  candleMode: bot.candleHandling.mode,
  direction: snapshot.direction,
  close: snapshot.close,
  emaShort: snapshot.emaShort,
  emaLong: snapshot.emaLong,
  atr: snapshot.atr,
  strengthPct: snapshot.strengthPct,
  strengthConfirmationPct: bot.config.strategyParams.strengthConfirmationPct,
  positionSize: bot.state.positionSize,
  balanceTotal: bot.state.balanceTotal,
  riskPct: bot.config.strategyParams.riskPct,
  calculatedSize: snapshot.calculatedSize ?? null,
  stopLoss: snapshot.stopLoss ?? null,
  reason,
  details,
});

export const recordCrossoverFromStrategySkip = (
  bot: { state: O1State; config: O1EnvConfig; candleHandling: O1CandleHandling },
  closedCandleTs: number,
  snapshot: O1CrossoverSnapshot,
  strategyReason: string
): O1CrossoverRecord | null => {
  const reason = mapStrategyReasonToCrossoverReason(strategyReason);
  if (!reason) return null;
  return recordCrossover(
    buildCrossoverRecordInput(bot, closedCandleTs, snapshot, reason, {
      strategyReason,
    })
  );
};
