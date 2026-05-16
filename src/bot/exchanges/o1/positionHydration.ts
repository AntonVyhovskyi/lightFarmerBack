import type { Nord } from "@n1xyz/nord-ts";
import { fetchActiveTriggers, toTriggerSpecFromApi } from "./liveTestSupport";
import { logInfo, logWarn, roundMetric } from "./logger";
import type { O1EnvConfig, O1State } from "./types";

export const hydrateExistingPositionState = async ({
  state,
  nord,
  config,
  priceDecimals,
  sizeDecimals,
}: {
  state: O1State;
  nord: Nord;
  config: O1EnvConfig;
  priceDecimals: number;
  sizeDecimals: number;
}): Promise<{ ok: boolean; reason?: string }> => {
  if (state.positionSize === 0) {
    return { ok: false, reason: "No open position to hydrate." };
  }
  if (!config.accountId) {
    return { ok: false, reason: "Missing accountId." };
  }

  const triggers = await fetchActiveTriggers(nord, config.accountId);
  const slTriggers = triggers.filter(
    (trigger) => trigger.marketId === config.marketId && trigger.kind === "stopLoss"
  );

  if (slTriggers.length !== 1) {
    return {
      ok: false,
      reason: `Expected exactly one stop-loss trigger, found ${slTriggers.length}.`,
    };
  }

  const spec = toTriggerSpecFromApi(slTriggers[0]!, priceDecimals, sizeDecimals);
  state.strategy.activeStopLossSpec = spec;
  state.strategy.currentStopLoss = spec.triggerPrice;
  state.strategy.lastEntryPrice = state.entryPrice > 0 ? state.entryPrice : null;

  const entry = state.entryPrice > 0 ? state.entryPrice : state.lastPrice;
  const isLong = state.positionSize > 0;
  const mark = state.lastPrice > 0 ? state.lastPrice : entry;
  const profitPct = isLong
    ? ((mark - entry) / entry) * 100
    : ((entry - mark) / entry) * 100;

  const forceTrailing = process.env.O1_TRAILING_FORCE_ACTIVE === "true";
  if (forceTrailing || (Number.isFinite(profitPct) && profitPct >= config.strategyParams.trailingStartPct)) {
    state.strategy.trailingActive = true;
  }

  logInfo("O1_HYDRATE", "Existing position management state restored", {
    positionSize: state.positionSize,
    entryPrice: roundMetric(state.entryPrice),
    currentStopLoss: roundMetric(state.strategy.currentStopLoss),
    trailingActive: state.strategy.trailingActive,
    profitPct: roundMetric(profitPct),
    trailingStartPct: config.strategyParams.trailingStartPct,
    forceTrailing,
  });

  return { ok: true };
};

export const logManageOnlyMode = (enabled: boolean): void => {
  if (!enabled) return;
  logInfo("O1_MANAGE_ONLY", "Position management only — new entries blocked", {});
};
