import { Side, TriggerKind, type Nord } from "@n1xyz/nord-ts";
import type { O1Executor } from "./executor";
import {
  fetchActiveTriggers,
  filterMarketTriggersByKind,
  roundToDecimals,
  sleep,
  summarizeTrigger,
  toTriggerSpecFromApi,
  verifyExchangeStopLoss,
} from "./liveTestSupport";
import { compactTriggerSpec, logError, logInfo, logWarn } from "./logger";
import type { O1EmaCrossoverAtrLiveParams, O1EnvConfig, O1State, O1TriggerSpec } from "./types";

export type StopGuardEvent =
  | "POSITION_OPENED"
  | "POSITION_CONFIRMED"
  | "POSITION_NOT_CONFIRMED"
  | "STOP_CREATE_STARTED"
  | "STOP_CREATE_SUCCESS"
  | "STOP_CREATE_FAILED"
  | "STOP_NOT_FOUND"
  | "STOP_VERIFIED"
  | "EMERGENCY_STOP_RECREATE"
  | "STOP_GUARD_SKIP"
  | "STOP_DUPLICATE_REMOVED";

export type StopGuardContext = {
  state: O1State;
  config: O1EnvConfig;
  nord: Nord;
  executor: O1Executor;
  priceDecimals: number;
  sizeDecimals: number;
  syncState: () => Promise<void>;
};

const DEFAULT_POSITION_WAIT_ATTEMPTS = 15;
const DEFAULT_POSITION_WAIT_MS = 1000;
const STOP_GUARD_DEBOUNCE_MS = 4000;

export const logStopGuard = (
  event: StopGuardEvent,
  ctx: StopGuardContext,
  extra: Record<string, unknown> = {}
): void => {
  const payload = {
    event,
    timestamp: Date.now(),
    symbol: ctx.config.symbol,
    marketId: ctx.config.marketId,
    accountId: ctx.config.accountId,
    side: ctx.state.positionSize > 0 ? "long" : ctx.state.positionSize < 0 ? "short" : "flat",
    positionSize: ctx.state.positionSize,
    entryPrice: ctx.state.entryPrice,
    stopPrice: ctx.state.strategy.currentStopLoss,
    triggerId: ctx.state.strategy.activeStopLossSpec?.triggerId?.toString(),
    ws: {
      accountConnected: ctx.state.ws.accountConnected,
      accountWsHasPayload: ctx.state.accountWsHasPayload,
      accountStateSource: ctx.state.accountStateSource,
      lastAccountUpdateAt: ctx.state.ws.lastAccountUpdateAt,
      reconnectCount: ctx.state.ws.reconnectCount,
    },
    ...extra,
  };
  if (event.includes("FAILED") || event === "STOP_NOT_FOUND" || event === "POSITION_NOT_CONFIRMED") {
    logError("O1_STOP_GUARD", event, payload);
  } else if (event === "EMERGENCY_STOP_RECREATE") {
    logWarn("O1_STOP_GUARD", event, payload);
  } else {
    logInfo("O1_STOP_GUARD", event, payload);
  }
};

export const waitForPositionConfirmation = async (
  ctx: StopGuardContext,
  options?: { maxAttempts?: number; delayMs?: number; orderId?: string }
): Promise<{ confirmed: boolean; positionSize: number; entryPrice: number; attempts: number }> => {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_POSITION_WAIT_ATTEMPTS;
  const delayMs = options?.delayMs ?? DEFAULT_POSITION_WAIT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await ctx.syncState();
    if (ctx.state.positionSize !== 0) {
      logStopGuard("POSITION_CONFIRMED", ctx, {
        attempts: attempt,
        orderId: options?.orderId,
        positionSize: ctx.state.positionSize,
        entryPrice: ctx.state.entryPrice,
      });
      return {
        confirmed: true,
        positionSize: ctx.state.positionSize,
        entryPrice: ctx.state.entryPrice,
        attempts: attempt,
      };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }

  logStopGuard("POSITION_NOT_CONFIRMED", ctx, {
    attempts: maxAttempts,
    orderId: options?.orderId,
  });
  return { confirmed: false, positionSize: 0, entryPrice: 0, attempts: maxAttempts };
};

const minStopDistancePct = (config: O1EnvConfig): number => {
  if (config.strategyName === "emaCrossoverAtrLiveStrategy") {
    return (config.strategyParams as O1EmaCrossoverAtrLiveParams).minStopDistancePct;
  }
  return 0.25;
};

const ensureStopOnCorrectSide = (
  isLong: boolean,
  entryPrice: number,
  plannedStop: number,
  pct: number,
  priceDecimals: number
): number => {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return roundToDecimals(plannedStop, priceDecimals);
  }
  const minDistance = entryPrice * (pct / 100);
  if (isLong) {
    const maxValid = entryPrice - minDistance;
    if (plannedStop >= entryPrice || plannedStop > maxValid) return roundToDecimals(maxValid, priceDecimals);
    return roundToDecimals(plannedStop, priceDecimals);
  }
  const minValid = entryPrice + minDistance;
  if (plannedStop <= entryPrice || plannedStop < minValid) return roundToDecimals(minValid, priceDecimals);
  return roundToDecimals(plannedStop, priceDecimals);
};

export const buildStopSpecForOpenPosition = (ctx: StopGuardContext): O1TriggerSpec | null => {
  const { state, config, priceDecimals, sizeDecimals } = ctx;
  const size = Math.abs(state.positionSize);
  if (size <= 0) return null;

  const isLong = state.positionSize > 0;
  const entry = state.entryPrice > 0 ? state.entryPrice : state.lastPrice;
  const existing = state.strategy.activeStopLossSpec;
  let triggerPrice =
    existing?.triggerPrice ??
    state.strategy.currentStopLoss ??
    (isLong ? entry * 0.9975 : entry * 1.0025);

  triggerPrice = ensureStopOnCorrectSide(
    isLong,
    entry,
    triggerPrice,
    minStopDistancePct(config),
    priceDecimals
  );

  const side = isLong ? Side.Ask : Side.Bid;
  if (existing) {
    const { limitPrice: _omit, ...rest } = existing;
    return { ...rest, triggerPrice, limitBaseSize: size, side };
  }
  return {
    marketId: config.marketId,
    side,
    kind: TriggerKind.StopLoss,
    triggerPrice,
    limitBaseSize: roundToDecimals(size, sizeDecimals),
  };
};

export type StopGuardResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; triggerId?: string; slCount: number }
  | { status: "recreated"; triggerId?: string }
  | { status: "closed"; reason: string };

export const ensureProtectiveStopLoss = async (
  ctx: StopGuardContext,
  source: string,
  options?: { force?: boolean; skipDebounce?: boolean }
): Promise<StopGuardResult> => {
  const { state, config, executor, priceDecimals, sizeDecimals } = ctx;

  if (config.dryRun) return { status: "skipped", reason: "dry-run" };
  if (state.positionSize === 0) {
    state.strategy.pendingEntryProtection = false;
    return { status: "skipped", reason: "flat" };
  }

  const now = Date.now();
  if (
    !options?.skipDebounce &&
    !options?.force &&
    state.lastStopGuardAt > 0 &&
    now - state.lastStopGuardAt < STOP_GUARD_DEBOUNCE_MS
  ) {
    return { status: "skipped", reason: "debounced" };
  }
  state.lastStopGuardAt = now;

  if (!config.accountId) return { status: "skipped", reason: "missing-account-id" };

  await ctx.syncState();

  if (state.positionSize === 0) {
    state.strategy.pendingEntryProtection = false;
    if (state.strategy.activeStopLossSpec !== null || state.strategy.currentStopLoss !== null) {
      state.strategy.activeStopLossSpec = null;
      state.strategy.currentStopLoss = null;
    }
    return { status: "skipped", reason: "flat-after-sync" };
  }

  let triggers: Awaited<ReturnType<typeof fetchActiveTriggers>>;
  try {
    triggers = await fetchActiveTriggers(ctx.nord, config.accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStopGuard("STOP_CREATE_FAILED", ctx, { source, reason: "trigger-fetch-failed", message });
    return { status: "skipped", reason: `trigger-fetch-failed:${message}` };
  }
  let slTriggers = filterMarketTriggersByKind(triggers, config.marketId, "stopLoss");

  if (slTriggers.length > 1) {
    const sorted = [...slTriggers].sort((a, b) => Number(a.triggerId) - Number(b.triggerId));
    const keep = sorted[sorted.length - 1]!;
    for (const extra of sorted.slice(0, -1)) {
      const spec = toTriggerSpecFromApi(extra, priceDecimals, sizeDecimals);
      logStopGuard("STOP_DUPLICATE_REMOVED", ctx, {
        source,
        removedTriggerId: String(extra.triggerId),
        keptTriggerId: String(keep.triggerId),
      });
      await executor.removeKnownTrigger(spec);
    }
    slTriggers = [keep];
  }

  const plannedSpec = buildStopSpecForOpenPosition(ctx);

  if (slTriggers.length >= 1) {
    const newest = slTriggers.reduce((a, b) => (Number(a.triggerId) > Number(b.triggerId) ? a : b));
    const spec = toTriggerSpecFromApi(newest, priceDecimals, sizeDecimals);
    state.strategy.activeStopLossSpec = spec;
    state.strategy.currentStopLoss = spec.triggerPrice;
    state.strategy.pendingEntryProtection = false;
    logStopGuard("STOP_VERIFIED", ctx, {
      source,
      triggerId: spec.triggerId?.toString(),
      slCount: slTriggers.length,
      summaries: slTriggers.map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals)),
    });
    return { status: "ok", triggerId: spec.triggerId?.toString(), slCount: slTriggers.length };
  }

  logStopGuard("STOP_NOT_FOUND", ctx, { source, slCount: 0 });
  logStopGuard("EMERGENCY_STOP_RECREATE", ctx, { source });

  if (!plannedSpec) {
    state.blockNewEntries = true;
    logStopGuard("STOP_CREATE_FAILED", ctx, { source, reason: "cannot-build-stop-spec" });
    await executor.closePosition();
    await ctx.syncState();
    return { status: "closed", reason: "cannot-build-stop-spec" };
  }

  state.strategy.activeStopLossSpec = plannedSpec;
  state.strategy.currentStopLoss = plannedSpec.triggerPrice;

  logStopGuard("STOP_CREATE_STARTED", ctx, { source, spec: compactTriggerSpec(plannedSpec) });

  const specForPlace: O1TriggerSpec = { ...plannedSpec, triggerId: undefined };
  const stopResult = await executor.placeInitialStopLoss(specForPlace, priceDecimals, sizeDecimals, 800);
  if (stopResult.ok === false) {
    state.blockNewEntries = true;
    logStopGuard("STOP_CREATE_FAILED", ctx, {
      source,
      reason: stopResult.reason,
      exchangeResponse: stopResult.rawError,
    });
    await ctx.syncState();
    await executor.closePosition();
    await ctx.syncState();
    return { status: "closed", reason: stopResult.reason };
  }

  if (stopResult.data?.triggerId) {
    state.strategy.activeStopLossSpec = {
      ...plannedSpec,
      triggerId: BigInt(stopResult.data.triggerId),
    };
  }

  const slVerify = await verifyExchangeStopLoss({
    nord: ctx.nord,
    accountId: config.accountId,
    marketId: config.marketId,
    expectedSpec: state.strategy.activeStopLossSpec ?? plannedSpec,
    priceDecimals,
    sizeDecimals,
    attempts: 6,
    delayMs: 1200,
  });

  if (!slVerify.ok) {
    state.blockNewEntries = true;
    logStopGuard("STOP_CREATE_FAILED", ctx, {
      source,
      reason: "exchange-verification-failed",
      slVerify,
    });
    await ctx.syncState();
    await executor.closePosition();
    await ctx.syncState();
    return { status: "closed", reason: "exchange-verification-failed" };
  }

  if (slVerify.matchedTriggerId && state.strategy.activeStopLossSpec) {
    state.strategy.activeStopLossSpec = {
      ...state.strategy.activeStopLossSpec,
      triggerId: BigInt(slVerify.matchedTriggerId),
    };
  }

  state.strategy.pendingEntryProtection = false;
  logStopGuard("STOP_CREATE_SUCCESS", ctx, {
    source,
    triggerId: state.strategy.activeStopLossSpec?.triggerId?.toString(),
    slCount: slVerify.slCount,
    triggerIds: slVerify.triggerIds,
  });

  return {
    status: "recreated",
    triggerId: state.strategy.activeStopLossSpec?.triggerId?.toString(),
  };
};
