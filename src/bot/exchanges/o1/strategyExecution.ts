import { Side } from "@n1xyz/nord-ts";
import type { O1CandleHandling } from "./candleResolution";
import { O1Executor } from "./executor";
import { compactTriggerSpec, logError, logInfo } from "./logger";
import {
  mapExecutorReasonToCrossoverReason,
  recordManagerCrossoverSkip,
  recordManagerEntryEvent,
} from "./history/recordEntryPath";
import type { O1CrossoverSnapshot } from "./strategies/emaAtrTrail3mStrategy";
import { roundToDecimals } from "./liveTestSupport";
import type { O1EmaCrossoverAtrLiveParams, O1EnvConfig, O1State } from "./types";

const ensureStopLossOnCorrectSide = (
  isLong: boolean,
  entryPrice: number,
  plannedStop: number,
  minStopDistancePct: number,
  priceDecimals: number
): number => {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return roundToDecimals(plannedStop, priceDecimals);
  }
  const minDistance = entryPrice * (minStopDistancePct / 100);
  if (isLong) {
    const maxValidStop = entryPrice - minDistance;
    if (plannedStop >= entryPrice || plannedStop > maxValidStop) {
      return roundToDecimals(maxValidStop, priceDecimals);
    }
    return roundToDecimals(plannedStop, priceDecimals);
  }
  const minValidStop = entryPrice + minDistance;
  if (plannedStop <= entryPrice || plannedStop < minValidStop) {
    return roundToDecimals(minValidStop, priceDecimals);
  }
  return roundToDecimals(plannedStop, priceDecimals);
};

export type O1OpenAction = {
  type: "openLong" | "openShort";
  size: number;
  entryPrice: number;
  stopLoss: number;
  crossover?: O1CrossoverSnapshot;
};

type BotCtx = {
  state: O1State;
  config: O1EnvConfig;
  candleHandling: O1CandleHandling;
  executor: O1Executor;
  priceDecimals: number;
  sizeDecimals: number;
  syncState: () => Promise<void>;
};

export const clampEntrySizeToLimits = (
  size: number,
  entryPrice: number,
  maxOrderNotional: number,
  maxPositionSize: number,
  sizeDecimals: number
): number => {
  if (!Number.isFinite(size) || size <= 0 || entryPrice <= 0) return 0;
  const maxByNotional = maxOrderNotional / entryPrice;
  const raw = Math.min(size, maxByNotional, maxPositionSize);
  const factor = 10 ** sizeDecimals;
  return Math.floor(raw * factor) / factor;
};

export const executeO1CrossoverEntry = async (
  bot: BotCtx,
  closedCandleTs: number,
  action: O1OpenAction
): Promise<void> => {
  const { state, config, candleHandling, executor } = bot;
  const direction = action.type === "openLong" ? "long" : "short";
  const snapshot = action.crossover;
  const historyCtx = { state, config, candleHandling };

  if (config.manageExistingPositionOnly) {
    recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-other", {
      block: "manage-existing-position-only",
    });
    logError("O1_STRATEGY_ERROR", "Entry blocked in manage-existing-position-only mode", {
      side: action.type,
      closedCandleTs,
    });
    return;
  }
  if (state.positionSize !== 0) {
    recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-existing-position", {
      positionSize: state.positionSize,
    });
    return;
  }

  const entrySize = clampEntrySizeToLimits(
    action.size,
    action.entryPrice,
    config.maxOrderNotional,
    config.maxPositionSize,
    bot.sizeDecimals
  );
  if (entrySize <= 0) {
    recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-invalid-size", {
      requestedSize: action.size,
      entryPrice: action.entryPrice,
      maxOrderNotional: config.maxOrderNotional,
    });
    logError("O1_STRATEGY_ERROR", "Entry size clamped to zero", {
      requestedSize: action.size,
      entryPrice: action.entryPrice,
      maxOrderNotional: config.maxOrderNotional,
    });
    return;
  }

  logInfo("O1_ENTRY", "Executing entry", {
    side: direction,
    size: entrySize,
    requestedSize: action.size,
    entryPrice: action.entryPrice,
    stopLoss: action.stopLoss,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    const crossoverRecord = recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-dry-run", {
      entrySize,
    });
    recordManagerEntryEvent(historyCtx, closedCandleTs, {
      crossoverId: crossoverRecord?.id ?? null,
      direction,
      entryPrice: action.entryPrice,
      size: entrySize,
      stopLoss: action.stopLoss,
      status: "attempted",
      orderResult: "dry-run",
    });
  }

  const openResult = action.type === "openLong"
    ? await executor.openLong(entrySize)
    : await executor.openShort(entrySize);
  if (openResult.ok === false) {
    recordManagerCrossoverSkip(
      historyCtx,
      closedCandleTs,
      snapshot,
      mapExecutorReasonToCrossoverReason(openResult.reason),
      { executorReason: openResult.reason }
    );
    recordManagerEntryEvent(historyCtx, closedCandleTs, {
      crossoverId: null,
      direction,
      entryPrice: action.entryPrice,
      size: entrySize,
      stopLoss: action.stopLoss,
      status: "failed",
      failureReason: openResult.reason,
    });
    logError("O1_STRATEGY_ERROR", "Entry order failed", { side: action.type, reason: openResult.reason });
    return;
  }

  const orderData = openResult.data as { actionId?: string; orderId?: string } | undefined;
  const orderResult = orderData?.actionId ?? orderData?.orderId ?? "ok";

  await bot.syncState();
  if (state.positionSize === 0) {
    if (!config.dryRun) {
      recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-executor-error", {
        note: "entry-ok-position-flat",
      });
      recordManagerEntryEvent(historyCtx, closedCandleTs, {
        crossoverId: null,
        direction,
        entryPrice: action.entryPrice,
        size: entrySize,
        stopLoss: action.stopLoss,
        status: "failed",
        failureReason: "position-still-flat-after-entry",
        orderResult: String(orderResult),
      });
    }
    logError("O1_STRATEGY_ERROR", "Entry reported success but position is still flat", {
      side: action.type,
      size: action.size,
    });
    return;
  }

  const crossoverRecord = config.dryRun
    ? null
    : recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "entered", { entrySize });

  const stopSide = action.type === "openLong" ? Side.Ask : Side.Bid;
  const stopSpec = state.strategy.activeStopLossSpec;
  if (!stopSpec) {
    recordManagerEntryEvent(historyCtx, closedCandleTs, {
      crossoverId: crossoverRecord?.id ?? null,
      direction,
      entryPrice: action.entryPrice,
      size: entrySize,
      stopLoss: action.stopLoss,
      status: "failed",
      failureReason: "missing-stop-loss-spec",
      orderResult: String(orderResult),
    });
    logError("O1_STRATEGY_ERROR", "Missing stop-loss spec after entry", { side: action.type });
    await executor.closePosition();
    return;
  }

  const stopSize = Math.abs(state.positionSize) > 0 ? Math.abs(state.positionSize) : entrySize;
  const fillEntry = state.entryPrice > 0 ? state.entryPrice : action.entryPrice;
  const isLong = state.positionSize > 0;
  const minStopPct =
    config.strategyName === "emaCrossoverAtrLiveStrategy"
      ? (config.strategyParams as O1EmaCrossoverAtrLiveParams).minStopDistancePct
      : 0.25;
  const adjustedTrigger = ensureStopLossOnCorrectSide(
    isLong,
    fillEntry,
    stopSpec.triggerPrice,
    minStopPct,
    bot.priceDecimals
  );
  if (adjustedTrigger !== stopSpec.triggerPrice) {
    logInfo("O1_SL", "Adjusted stop-loss for fill price", {
      plannedStop: stopSpec.triggerPrice,
      fillEntry,
      adjustedStop: adjustedTrigger,
      minStopDistancePct: minStopPct,
    });
  }
  const stopSpecForPosition = {
    ...stopSpec,
    triggerPrice: adjustedTrigger,
    limitBaseSize: stopSize,
  };
  state.strategy.activeStopLossSpec = stopSpecForPosition;
  state.strategy.currentStopLoss = adjustedTrigger;
  logInfo("O1_SL", "Placing initial stop-loss", compactTriggerSpec(stopSpecForPosition));
  if (!config.dryRun) {
    const stopResult = await executor.placeInitialStopLoss(
      stopSpecForPosition,
      bot.priceDecimals,
      bot.sizeDecimals
    );
    if (stopResult.ok && stopResult.data?.triggerId) {
      state.strategy.activeStopLossSpec = {
        ...stopSpecForPosition,
        triggerId: BigInt(stopResult.data.triggerId),
      };
    }
    if (stopResult.ok === false) {
      recordManagerEntryEvent(historyCtx, closedCandleTs, {
        crossoverId: crossoverRecord?.id ?? null,
        direction,
        entryPrice: action.entryPrice,
        size: entrySize,
        stopLoss: action.stopLoss,
        status: "closed-by-safety",
        failureReason: stopResult.reason,
        orderResult: String(orderResult),
        slTriggerResult: stopResult.reason,
      });
      logError("O1_STRATEGY_ERROR", "Initial stop-loss placement failed; closing position", {
        reason: stopResult.reason,
      });
      await bot.syncState();
      await executor.closePosition();
      return;
    }
    recordManagerEntryEvent(historyCtx, closedCandleTs, {
      crossoverId: crossoverRecord?.id ?? null,
      direction,
      entryPrice: action.entryPrice,
      size: entrySize,
      stopLoss: adjustedTrigger,
      status: "opened",
      orderResult: String(orderResult),
      slTriggerResult: "placed",
    });
  }

  state.strategy.tradesTodayCount += 1;
  state.trailingActive = false;
};

export const executeO1StopLossUpdate = async (
  bot: BotCtx,
  action: { stopLoss: number; previousStopLoss: number; updateKind: "break-even" | "trailing" }
): Promise<boolean> => {
  const { state, config, executor } = bot;
  const currentSpec = state.strategy.activeStopLossSpec;
  if (!currentSpec) {
    logError("O1_STRATEGY_ERROR", "Stop update requested without active stop-loss spec");
    return false;
  }

  const nextSpec = { ...currentSpec, triggerPrice: action.stopLoss };
  const logTag = action.updateKind === "break-even" ? "O1_BE" : "O1_TRAIL";
  logInfo(logTag, "Updating stop-loss", {
    oldSL: action.previousStopLoss,
    newSL: action.stopLoss,
    dryRun: config.dryRun,
  });

  let triggerId = currentSpec.triggerId;
  if (!config.dryRun) {
    const updateResult = await executor.updateStopLoss(currentSpec, nextSpec);
    if (updateResult.ok === false) {
      logError("O1_STRATEGY_ERROR", "Stop-loss update failed", {
        kind: action.updateKind,
        reason: updateResult.reason,
      });
      return false;
    }
    if (updateResult.data?.triggerId) {
      triggerId = BigInt(updateResult.data.triggerId);
    }
  }

  state.strategy.activeStopLossSpec = { ...nextSpec, triggerId };
  return true;
};

export const executeO1ClosePosition = async (bot: BotCtx, reason: string): Promise<void> => {
  const { state, config, executor } = bot;
  logInfo("O1_CLOSE", "Closing position", { reason, dryRun: config.dryRun });
  if (!config.dryRun) {
    const closeResult = await executor.closePosition();
    if (closeResult.ok === false) {
      logError("O1_STRATEGY_ERROR", "Close position failed", { reason: closeResult.reason });
    }
  }
  state.strategy.lastSignal = "close";
  state.strategy.lastSignalReason = reason;
};
