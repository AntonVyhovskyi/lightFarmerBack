import dotenv from "dotenv";
import { Side, TriggerKind, type Nord } from "@n1xyz/nord-ts";
import { initO1Client } from "../bot/exchanges/o1/client";
import { readO1Env } from "../bot/exchanges/o1/env";
import { normalizeO1Error } from "../bot/exchanges/o1/errors";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  isMainnetO1Env,
  readO1LiveTestEnv,
  roundToDecimals,
  seedExecutorStateForLiveTest,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
  waitForAccountFlat,
  waitForRecordedTriggers,
} from "../bot/exchanges/o1/liveTestSupport";
import { createInitialO1State } from "../bot/exchanges/o1/state";
import type { O1EnvConfig, O1Result, O1State, O1TriggerSpec } from "../bot/exchanges/o1/types";

dotenv.config();

type FailedResult = Extract<O1Result, { ok: false }>;

const failedResult = (result: O1Result): FailedResult | undefined => {
  if (result.ok === false) return result;
  return undefined;
};

type AccountSnapshot = {
  accountId?: number;
  positionSize: number;
  entryPrice: number;
  balanceTotal: number;
  balanceAvailable: number;
  openOrders: number;
  activeTriggers: number;
};

type TestContext = {
  config: O1EnvConfig;
  nord: Nord;
  user: Awaited<ReturnType<typeof initO1Client>>["user"];
  state: O1State;
  executor: O1Executor;
  stage: string;
  maxNotional: number;
  sizeDecimals: number;
  priceDecimals: number;
  lastPrice: number;
  entryPrice: number;
  orderSize: number;
  slSpec?: O1TriggerSpec;
  tpSpec?: O1TriggerSpec;
};

const logStep = (tag: string, step: string, payload: Record<string, unknown>, result: unknown, snapshot: AccountSnapshot) => {
  console.log(`[${tag}] ${step}`, { payload, result, snapshot });
};

const snapshotFrom = async (ctx: TestContext): Promise<AccountSnapshot> => {
  await ctx.executor.syncAccount();
  syncO1StateFromUser(ctx.state, ctx.user, ctx.config.accountId!, ctx.config.marketId);
  const triggers = await fetchActiveTriggers(ctx.nord, ctx.config.accountId!);
  const activeTriggers = triggers.filter((trigger) => trigger.marketId === ctx.config.marketId);
  return {
    accountId: ctx.config.accountId,
    positionSize: ctx.state.positionSize,
    entryPrice: ctx.state.entryPrice,
    balanceTotal: ctx.state.balanceTotal,
    balanceAvailable: ctx.state.balanceAvailable,
    openOrders: ctx.state.orders.length,
    activeTriggers: activeTriggers.length,
  };
};

const fail = async (ctx: TestContext, reason: string, rawError?: unknown, payload?: Record<string, unknown>) => {
  const normalized = rawError ? normalizeO1Error(rawError) : undefined;
  const snapshot = await snapshotFrom(ctx).catch(() => ({
    accountId: ctx.config.accountId,
    positionSize: ctx.state.positionSize,
    entryPrice: ctx.state.entryPrice,
    balanceTotal: ctx.state.balanceTotal,
    balanceAvailable: ctx.state.balanceAvailable,
    openOrders: ctx.state.orders.length,
    activeTriggers: 0,
  }));

  console.error("[O1_TEST_ERROR]", {
    stage: ctx.stage,
    reason,
    rawMessage: rawError instanceof Error ? rawError.message : String(rawError ?? reason),
    rawCode: (rawError as { code?: string })?.code,
    payload,
    normalized,
    position: snapshot.positionSize,
    openOrders: snapshot.openOrders,
    triggers: snapshot.activeTriggers,
  });

  await emergencyCleanup(ctx);
  process.exit(1);
};

const emergencyCleanup = async (ctx: TestContext) => {
  const recordedSpecs = [ctx.slSpec, ctx.tpSpec].filter((spec): spec is O1TriggerSpec => spec !== undefined);
  for (const spec of recordedSpecs) {
    const removeResult = await ctx.executor.removeKnownTrigger(spec);
    console.log("[O1_TEST_TRIGGER_REMOVE]", { spec, result: removeResult });
  }

  const triggers = await fetchActiveTriggers(ctx.nord, ctx.config.accountId!).catch(() => []);
  for (const trigger of triggers) {
    if (trigger.marketId !== ctx.config.marketId) continue;
    const spec = toTriggerSpecFromApi(trigger, ctx.priceDecimals, ctx.sizeDecimals);
    const removeResult = await ctx.executor.removeKnownTrigger(spec);
    console.log("[O1_TEST_TRIGGER_REMOVE]", { spec, result: removeResult });
  }

  await ctx.executor.cancelAllKnownOrders();
  if (ctx.state.positionSize !== 0) {
    console.warn("[O1_TEST_ERROR] Position still open after cleanup attempt.", {
      positionSize: ctx.state.positionSize,
    });
    if (process.env.O1_TEST_AUTO_CLOSE_ON_ERROR === "true") {
      await ctx.executor.closePosition();
    }
  }
};

const assertZeroLeftovers = async (ctx: TestContext) => {
  const flat = await waitForAccountFlat({
    nord: ctx.nord,
    executor: ctx.executor,
    state: ctx.state,
    user: ctx.user,
    accountId: ctx.config.accountId!,
    marketId: ctx.config.marketId,
    priceDecimals: ctx.priceDecimals,
    sizeDecimals: ctx.sizeDecimals,
    requireTriggersZero: true,
  });
  const snapshot: AccountSnapshot = {
    accountId: ctx.config.accountId,
    positionSize: flat.positionSize,
    entryPrice: ctx.state.entryPrice,
    balanceTotal: ctx.state.balanceTotal,
    balanceAvailable: ctx.state.balanceAvailable,
    openOrders: flat.openOrders,
    activeTriggers: flat.activeTriggers,
  };
  if (!flat.ok) {
    await fail(ctx, "Final verification failed: leftovers remain.", undefined, {
      ...snapshot,
      attempt: flat.attempt,
      triggerSummaries: flat.triggerSummaries,
    });
  }
  console.log("[O1_TEST_FINAL]", { snapshot, attempt: flat.attempt, triggerSummaries: flat.triggerSummaries });
};

const toTriggerSpec = (trigger: Awaited<ReturnType<typeof fetchActiveTriggers>>[number], ctx: TestContext): O1TriggerSpec =>
  toTriggerSpecFromApi(trigger, ctx.priceDecimals, ctx.sizeDecimals);

async function main() {
  const testEnv = readO1LiveTestEnv();
  preflightEnv(testEnv);

  const { config, nord, user } = await initO1Client();
  const state = createInitialO1State(config);
  const liveConfig: O1EnvConfig = {
    ...config,
    enabled: true,
    dryRun: false,
    maxOrderNotional: testEnv.maxNotional,
    maxPositionSize: Math.max(config.maxPositionSize, testEnv.maxNotional),
    defaultLeverage: config.defaultLeverage,
  };

  const ctx: TestContext = {
    config: liveConfig,
    nord,
    user,
    state,
    executor: new O1Executor(user, liveConfig, state),
    stage: "init",
    maxNotional: testEnv.maxNotional,
    sizeDecimals: 4,
    priceDecimals: 2,
    lastPrice: 0,
    entryPrice: 0,
    orderSize: 0,
  };

  console.log("[O1_TEST_INIT]", {
    webServerUrl: liveConfig.webServerUrl,
    wsUrl: liveConfig.wsUrl,
    solanaRpcUrl: liveConfig.solanaRpcUrl,
    symbol: liveConfig.symbol,
    marketId: liveConfig.marketId,
    accountId: liveConfig.accountId,
    maxNotional: testEnv.maxNotional,
    defaultLeverage: liveConfig.defaultLeverage,
    dryRun: liveConfig.dryRun,
  });

  ctx.stage = "preflight";
  if (!liveConfig.accountId) {
    await fail(ctx, "accountId missing.");
  }

  const sync = await ctx.executor.syncAccount();
  if (!sync.ok) await fail(ctx, "Account sync failed during preflight.", failedResult(sync)?.rawError, { sync });
  syncO1StateFromUser(ctx.state, ctx.user, liveConfig.accountId!, liveConfig.marketId);
  const preflightSnapshot = await snapshotFrom(ctx);
  logStep("O1_TEST_PREFLIGHT", "account-sync", {}, sync, preflightSnapshot);

  if (preflightSnapshot.positionSize !== 0) await fail(ctx, "Preflight rejected: position is not zero.", undefined, preflightSnapshot);
  if (preflightSnapshot.openOrders > 0) await fail(ctx, "Preflight rejected: open orders exist.", undefined, preflightSnapshot);
  if (preflightSnapshot.activeTriggers > 0) await fail(ctx, "Preflight rejected: active triggers exist.", undefined, preflightSnapshot);
  if (preflightSnapshot.balanceAvailable < testEnv.maxNotional) {
    await fail(ctx, "Preflight rejected: insufficient balance.", undefined, preflightSnapshot);
  }

  ctx.stage = "market-info";
  const info = await nord.getInfo();
  const market = info.markets.find((entry) => entry.marketId === liveConfig.marketId || entry.symbol === liveConfig.symbol);
  if (!market) await fail(ctx, "Market info not found for configured symbol/marketId.");
  ctx.sizeDecimals = market.sizeDecimals;
  ctx.priceDecimals = market.priceDecimals;

  const orderbook = await nord.getOrderbook({ marketId: liveConfig.marketId, symbol: liveConfig.symbol });
  const bestAsk = orderbook.asks[0]?.[0];
  const bestBid = orderbook.bids[0]?.[0];
  ctx.lastPrice = Number(bestAsk ?? bestBid ?? 0);
  if (!Number.isFinite(ctx.lastPrice) || ctx.lastPrice <= 0) await fail(ctx, "Unable to resolve market price.");

  ctx.orderSize = roundToDecimals(testEnv.maxNotional / ctx.lastPrice, ctx.sizeDecimals);
  const notional = ctx.orderSize * ctx.lastPrice;
  if (notional > testEnv.maxNotional) await fail(ctx, "Computed notional exceeds max test notional.", undefined, { notional, maxNotional: testEnv.maxNotional });
  seedExecutorStateForLiveTest(ctx.state, ctx.lastPrice);

  ctx.stage = "open-long";
  const openPayload = { marketId: liveConfig.marketId, side: Side.Bid, size: ctx.orderSize, notional };
  console.log("[O1_TEST_OPEN_SEND]", openPayload);
  const openResult = await ctx.executor.openLong(ctx.orderSize);
  console.log("[O1_TEST_OPEN_RESULT]", openResult);
  if (!openResult.ok) await fail(ctx, "Open long failed.", failedResult(openResult)?.rawError, openPayload);

  ctx.stage = "verify-open";
  const openSnapshot = await snapshotFrom(ctx);
  logStep("O1_TEST_SYNC_RESULT", "after-open", openPayload, openResult, openSnapshot);
  if (openSnapshot.positionSize <= 0) await fail(ctx, "Open verification failed: no long position detected.", undefined, openSnapshot);
  ctx.entryPrice = openSnapshot.entryPrice > 0 ? openSnapshot.entryPrice : ctx.lastPrice;

  const closeSide = Side.Ask;
  const slPrice = roundToDecimals(ctx.entryPrice * 0.98, ctx.priceDecimals);
  const tpPrice = roundToDecimals(ctx.entryPrice * 1.02, ctx.priceDecimals);
  ctx.slSpec = {
    marketId: liveConfig.marketId,
    side: closeSide,
    kind: TriggerKind.StopLoss,
    triggerPrice: slPrice,
    limitBaseSize: Math.abs(openSnapshot.positionSize),
  };
  ctx.tpSpec = {
    marketId: liveConfig.marketId,
    side: closeSide,
    kind: TriggerKind.TakeProfit,
    triggerPrice: tpPrice,
    limitBaseSize: Math.abs(openSnapshot.positionSize),
  };

  ctx.stage = "place-sl";
  console.log("[O1_TEST_SL_SEND]", ctx.slSpec);
  const slResult = await ctx.executor.placeStopLoss(ctx.slSpec.triggerPrice, ctx.slSpec.side, ctx.slSpec.limitBaseSize);
  console.log("[O1_TEST_SL_RESULT]", slResult);
  if (!slResult.ok) await fail(ctx, "Stop-loss placement failed.", failedResult(slResult)?.rawError, ctx.slSpec);

  ctx.stage = "place-tp";
  console.log("[O1_TEST_TP_SEND]", ctx.tpSpec);
  const tpResult = await ctx.executor.placeTakeProfit(ctx.tpSpec.triggerPrice, ctx.tpSpec.side, ctx.tpSpec.limitBaseSize);
  console.log("[O1_TEST_TP_RESULT]", tpResult);
  if (!tpResult.ok) await fail(ctx, "Take-profit placement failed.", failedResult(tpResult)?.rawError, ctx.tpSpec);

  ctx.stage = "verify-triggers";
  const initialTriggerCheck = await waitForRecordedTriggers({
    nord: ctx.nord,
    accountId: liveConfig.accountId!,
    marketId: liveConfig.marketId,
    specs: [ctx.slSpec, ctx.tpSpec],
    priceDecimals: ctx.priceDecimals,
    sizeDecimals: ctx.sizeDecimals,
  });
  console.log("[O1_TEST_TRIGGER_VERIFY]", {
    stage: "initial",
    ok: initialTriggerCheck.ok,
    attempt: initialTriggerCheck.attempt,
    count: initialTriggerCheck.marketTriggers.length,
    summaries: initialTriggerCheck.summaries,
    missingSpecs: initialTriggerCheck.missingSpecs,
    expectedSpecs: [ctx.slSpec, ctx.tpSpec],
  });
  if (!initialTriggerCheck.ok) {
    await fail(ctx, "Trigger verification failed after initial placement.", undefined, {
      count: initialTriggerCheck.marketTriggers.length,
      attempt: initialTriggerCheck.attempt,
      summaries: initialTriggerCheck.summaries,
      missingSpecs: initialTriggerCheck.missingSpecs,
    });
  }

  ctx.stage = "update-sl";
  const nextSlSpec: O1TriggerSpec = {
    ...ctx.slSpec,
    triggerPrice: roundToDecimals(ctx.entryPrice * 0.99, ctx.priceDecimals),
  };
  const updateSlResult = await ctx.executor.updateStopLoss(ctx.slSpec, nextSlSpec);
  console.log("[O1_TEST_UPDATE_SL_RESULT]", updateSlResult);
  if (!updateSlResult.ok) await fail(ctx, "Stop-loss update failed.", failedResult(updateSlResult)?.rawError, { old: ctx.slSpec, next: nextSlSpec });
  ctx.slSpec = nextSlSpec;

  ctx.stage = "update-tp";
  const nextTpSpec: O1TriggerSpec = {
    ...ctx.tpSpec,
    triggerPrice: roundToDecimals(ctx.entryPrice * 1.015, ctx.priceDecimals),
  };
  const updateTpResult = await ctx.executor.updateTakeProfit(ctx.tpSpec, nextTpSpec);
  console.log("[O1_TEST_UPDATE_TP_RESULT]", updateTpResult);
  if (!updateTpResult.ok) await fail(ctx, "Take-profit update failed.", failedResult(updateTpResult)?.rawError, { old: ctx.tpSpec, next: nextTpSpec });
  ctx.tpSpec = nextTpSpec;

  ctx.stage = "verify-updated-triggers";
  const updatedTriggerCheck = await waitForRecordedTriggers({
    nord: ctx.nord,
    accountId: liveConfig.accountId!,
    marketId: liveConfig.marketId,
    specs: [ctx.slSpec, ctx.tpSpec],
    priceDecimals: ctx.priceDecimals,
    sizeDecimals: ctx.sizeDecimals,
  });
  console.log("[O1_TEST_TRIGGER_VERIFY]", {
    stage: "updated",
    ok: updatedTriggerCheck.ok,
    attempt: updatedTriggerCheck.attempt,
    count: updatedTriggerCheck.marketTriggers.length,
    summaries: updatedTriggerCheck.summaries,
    missingSpecs: updatedTriggerCheck.missingSpecs,
    expectedSpecs: [ctx.slSpec, ctx.tpSpec],
  });
  if (!updatedTriggerCheck.ok) {
    await fail(ctx, "Trigger verification failed after update.", undefined, {
      count: updatedTriggerCheck.marketTriggers.length,
      attempt: updatedTriggerCheck.attempt,
      summaries: updatedTriggerCheck.summaries,
      missingSpecs: updatedTriggerCheck.missingSpecs,
    });
  }

  ctx.stage = "close-position";
  const closeResult = await ctx.executor.closePosition();
  console.log("[O1_TEST_CLOSE_RESULT]", closeResult);
  if (!closeResult.ok) await fail(ctx, "Close position failed.", failedResult(closeResult)?.rawError);

  const flatAfterClose = await waitForAccountFlat({
    nord: ctx.nord,
    executor: ctx.executor,
    state: ctx.state,
    user: ctx.user,
    accountId: liveConfig.accountId!,
    marketId: liveConfig.marketId,
    priceDecimals: ctx.priceDecimals,
    sizeDecimals: ctx.sizeDecimals,
    requireTriggersZero: false,
  });
  console.log("[O1_TEST_CLOSE_SYNC]", {
    ok: flatAfterClose.ok,
    attempt: flatAfterClose.attempt,
    positionSize: flatAfterClose.positionSize,
    openOrders: flatAfterClose.openOrders,
    activeTriggers: flatAfterClose.activeTriggers,
    triggerSummaries: flatAfterClose.triggerSummaries,
  });
  if (!flatAfterClose.ok) {
    await fail(ctx, "Close verification failed: position did not flatten.", undefined, flatAfterClose);
  }

  ctx.stage = "cleanup";
  const triggersAfterClose = (await fetchActiveTriggers(ctx.nord, liveConfig.accountId!)).filter(
    (trigger) => trigger.marketId === liveConfig.marketId
  );
  for (const trigger of triggersAfterClose) {
    const removeResult = await ctx.executor.removeKnownTrigger(toTriggerSpec(trigger, ctx));
    if (!removeResult.ok) await fail(ctx, "Trigger cleanup failed.", failedResult(removeResult)?.rawError, toTriggerSpec(trigger, ctx));
  }
  const cancelResult = await ctx.executor.cancelAllKnownOrders();
  console.log("[O1_TEST_CANCEL_RESULT]", cancelResult);
  if (!cancelResult.ok) await fail(ctx, "Cancel open orders failed.", failedResult(cancelResult)?.rawError);

  ctx.stage = "final";
  await assertZeroLeftovers(ctx);
}

function preflightEnv(testEnv: ReturnType<typeof readO1LiveTestEnv>) {
  if (!testEnv.allowLiveTest) {
    console.error("[O1_TEST_PREFLIGHT] Aborted: O1_ALLOW_LIVE_TEST is not true.");
    process.exit(1);
  }
  if (testEnv.dryRun) {
    console.error("[O1_TEST_PREFLIGHT] Aborted: O1_DRY_RUN=true. Live test requires O1_DRY_RUN=false.");
    process.exit(1);
  }
  if (!Number.isFinite(testEnv.maxNotional) || testEnv.maxNotional <= 0) {
    console.error("[O1_TEST_PREFLIGHT] Aborted: O1_TEST_MAX_NOTIONAL must be a positive number.");
    process.exit(1);
  }
  const config = readO1Env();
  if (isMainnetO1Env(config) && !testEnv.mainnetConfirmed) {
    console.error("[O1_TEST_PREFLIGHT] Aborted: mainnet requires O1_TEST_MAINNET_CONFIRMED=true.");
    process.exit(1);
  }
}

main().catch(async (error: unknown) => {
  console.error("[O1_TEST_ERROR]", {
    stage: "unhandled",
    reason: error instanceof Error ? error.message : String(error),
    rawMessage: error instanceof Error ? error.message : String(error),
    rawError: error,
  });
  process.exit(1);
});
