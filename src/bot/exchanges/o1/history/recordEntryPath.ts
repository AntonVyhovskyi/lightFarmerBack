import type { O1CandleHandling } from "../candleResolution";
import type { O1CrossoverSnapshot } from "../strategies/emaAtrTrail3mStrategy";
import { strengthDetailsForCrossover } from "../strategies/strengthPct";
import type { O1EnvConfig, O1State } from "../types";
import { recordCrossover } from "./crossoverCache";
import { recordEntry } from "./entryCache";
import { buildCrossoverRecordInput } from "./recordFromStrategy";
import type { O1CrossoverDirection, O1CrossoverReason, O1CrossoverRecord, O1EntryRecord, O1EntryStatus } from "./types";

type O1BotHistoryContext = {
  state: O1State;
  config: O1EnvConfig;
  candleHandling: O1CandleHandling;
};

export const mapExecutorReasonToCrossoverReason = (reason: string): O1CrossoverReason => {
  if (reason.includes("cooldown")) return "skipped-cooldown";
  if (reason.includes("notional")) return "skipped-max-notional";
  return "skipped-executor-error";
};

export const recordManagerCrossoverSkip = (
  bot: O1BotHistoryContext,
  closedCandleTs: number,
  snapshot: O1CrossoverSnapshot | undefined,
  reason: O1CrossoverReason,
  details: Record<string, unknown>
): O1CrossoverRecord | null => {
  if (!snapshot) return null;
  return recordCrossover(
    buildCrossoverRecordInput(bot, closedCandleTs, snapshot, reason, {
      ...details,
      ...strengthDetailsForCrossover(snapshot.strengthDetails),
    })
  );
};

export const recordManagerEntryEvent = (
  bot: O1BotHistoryContext,
  closedCandleTs: number,
  opts: {
    crossoverId: string | null;
    direction: O1CrossoverDirection;
    entryPrice: number;
    size: number;
    stopLoss: number | null;
    status: O1EntryStatus;
    failureReason?: string | null;
    orderResult?: string | null;
    slTriggerResult?: string | null;
  }
): O1EntryRecord => {
  const notional = opts.entryPrice * opts.size;
  return recordEntry({
    crossoverId: opts.crossoverId,
    candleTs: closedCandleTs,
    symbol: bot.config.symbol,
    resolution: bot.candleHandling.effectiveResolution,
    direction: opts.direction,
    entryPrice: opts.entryPrice,
    size: opts.size,
    notional,
    leverage: bot.config.strategyParams.leverage,
    stopLoss: opts.stopLoss,
    dryRun: bot.config.dryRun,
    orderResult: opts.orderResult ?? null,
    slTriggerResult: opts.slTriggerResult ?? null,
    status: opts.status,
    failureReason: opts.failureReason ?? null,
  });
};
