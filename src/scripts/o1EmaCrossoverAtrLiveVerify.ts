/**
 * Real-money end-to-end verification for emaCrossoverAtrLiveStrategy.
 */
import dotenv from "dotenv";

dotenv.config();

const applyVerifyEnv = (): void => {
  process.env.O1_STRATEGY = "emaCrossoverAtrLiveStrategy";
  process.env.O1_DRY_RUN = "false";
  process.env.O1_RESOLUTION = "1";
  process.env.O1_EMA_SHORT_PERIOD = "2";
  process.env.O1_EMA_LONG_PERIOD = "3";
  process.env.O1_ATR_PERIOD = "5";
  process.env.O1_ATR_STOP_MULTIPLIER = "0.8";
  process.env.O1_BREAK_EVEN_PCT = "0.05";
  process.env.O1_TRAILING_START_PCT = "0.05";
  process.env.O1_TRAILING_GAP_PCT = "0.1";
  process.env.O1_RISK_PCT = "1";
  process.env.O1_DEFAULT_LEVERAGE = "3";
  process.env.O1_MAX_ORDER_NOTIONAL = "12";
  process.env.O1_COOLDOWN_CANDLES = "1";
  process.env.O1_MIN_MOVE_VS_FEE_MULT = "0";
  process.env.O1_FEE_RATE = "0.00035";
  process.env.O1_CANDLE_POLL_MS = "15000";
  process.env.O1_LOG_LEVEL = "info";
  process.env.O1_MANAGE_EXISTING_POSITION_ONLY = "false";
  process.env.O1_TRAILING_FORCE_ACTIVE = "true";
};

applyVerifyEnv();

import { getInitializedO1Client, initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { O1Executor } from "../bot/exchanges/o1/executor";
import { listCrossovers, listEntries } from "../bot/exchanges/o1/history";
import {
  fetchActiveTriggers,
  sleep,
  summarizeTrigger,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
  waitForAccountFlat,
  type O1TriggerSummary,
} from "../bot/exchanges/o1/liveTestSupport";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";

const ENTRY_MAX_MS = Number(process.env.O1_VERIFY_ENTRY_MAX_MS ?? String(25 * 60_000));
const SL_MAX_MS = Number(process.env.O1_VERIFY_SL_MAX_MS ?? "120000");
const MANAGE_MAX_MS = Number(process.env.O1_VERIFY_MANAGE_MAX_MS ?? String(8 * 60_000));
const POLL_MS = Number(process.env.O1_VERIFY_POLL_MS ?? "4000");

const withRetries = async <T>(label: string, fn: () => Promise<T>, attempts = 5, delayMs = 2000): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[O1_LIVE_VERIFY] ${label} retry`, {
        attempt,
        attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
};

const TAGS = [
  "O1_CANDLE_POLL",
  "O1_CLOSED_DIRECT_CANDLE",
  "O1_STRATEGY_TICK",
  "O1_CROSSOVER_RECORDED",
  "O1_ENTRY",
  "O1_ENTRY_RECORDED",
  "O1_SL",
  "O1_BE",
  "O1_TRAIL",
  "O1_CLOSE",
  "O1_POSITION_CLEARED",
  "O1_STALE_TRIGGER_CLEANUP",
] as const;

type Tag = (typeof TAGS)[number];
const seenTags = new Set<Tag>();
const capturedLogs: string[] = [];

const noteTag = (line: string): void => {
  for (const tag of TAGS) {
    if (line.includes(`[${tag}]`)) {
      seenTags.add(tag);
      capturedLogs.push(line);
    }
  }
};

const installCapture = (): (() => void) => {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const wrap = (fn: typeof console.log) => (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    noteTag(line);
    fn(...args);
  };
  console.log = wrap(origLog);
  console.warn = wrap(origWarn);
  console.error = wrap(origError);
  return () => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
};

const emergencyCleanup = async (reason: string): Promise<void> => {
  console.error("[O1_LIVE_VERIFY] emergency cleanup", { reason });
  try {
    const { config, nord, user } = await initO1Client();
    if (!config.accountId) return;
    const state = createInitialO1State(config);
    const executor = new O1Executor(user, config, state);
    await executor.syncAccount();
    syncO1StateFromUser(state, user, config.accountId!, config.marketId);
    if (state.positionSize !== 0) {
      await executor.closePosition();
      await sleep(2000);
    }
    const info = await nord.getInfo();
    const market = info.markets.find((m) => m.marketId === config.marketId);
    const priceDecimals = market?.priceDecimals ?? 2;
    const sizeDecimals = market?.sizeDecimals ?? 4;
    const triggers = await fetchActiveTriggers(nord, config.accountId);
    for (const trigger of triggers.filter((t) => t.marketId === config.marketId)) {
      const spec = toTriggerSpecFromApi(trigger, priceDecimals, sizeDecimals);
      await executor.removeKnownTrigger(spec);
    }
  } catch (err) {
    console.error("[O1_LIVE_VERIFY] emergency cleanup failed", err);
  }
};

const fail = async (reason: string, extra: Record<string, unknown> = {}): Promise<never> => {
  await emergencyCleanup(reason);
  console.error("[O1_LIVE_VERIFY_FAIL]", { reason, ...extra, seenTags: [...seenTags] });
  console.log("[O1_LIVE_VERIFY] captured logs (tail)", capturedLogs.slice(-60));
  process.exit(1);
};

async function preflight(): Promise<{ positionSize: number; openOrders: number; activeTriggers: number }> {
  const { config, nord, user } = await initO1Client();
  if (!config.accountId) throw new Error("Missing O1_ACCOUNT_ID");
  const state = createInitialO1State(config);
  const executor = new O1Executor(user, config, state);
  const sync = await executor.syncAccount();
  if (!sync.ok) throw new Error(`Preflight sync failed: ${sync.reason}`);
  syncO1StateFromUser(state, user, config.accountId, config.marketId);
  const triggers = await fetchActiveTriggers(nord, config.accountId);
  const marketTriggers = triggers.filter((t) => t.marketId === config.marketId);
  return {
    positionSize: state.positionSize,
    openOrders: state.orders.length,
    activeTriggers: marketTriggers.length,
  };
};

async function cleanupAllTriggers(
  nord: Awaited<ReturnType<typeof initO1Client>>["nord"],
  executor: O1Executor,
  accountId: number,
  marketId: number,
  priceDecimals: number,
  sizeDecimals: number
): Promise<number> {
  const triggers = await fetchActiveTriggers(nord, accountId);
  const marketTriggers = triggers.filter((t) => t.marketId === marketId);
  let removed = 0;
  for (const trigger of marketTriggers) {
    const spec = toTriggerSpecFromApi(trigger, priceDecimals, sizeDecimals);
    const result = await executor.removeKnownTrigger(spec);
    if (result.ok) removed += 1;
  }
  return removed;
};

async function main(): Promise<void> {
  if (process.env.O1_ENABLED !== "true") {
    await fail("O1_ENABLED must be true");
  }
  if (process.env.O1_ALLOW_LIVE_TEST !== "true" || process.env.O1_TEST_MAINNET_CONFIRMED !== "true") {
    await fail("Set O1_ALLOW_LIVE_TEST=true and O1_TEST_MAINNET_CONFIRMED=true");
  }

  resetO1Client();
  const { config } = await initO1Client();
  const accountId = config.accountId;
  if (!accountId) await fail("Unable to resolve O1 accountId from Nord user");

  if (config.dryRun) await fail("O1_DRY_RUN must be false", { dryRun: config.dryRun });
  if (config.strategyName !== "emaCrossoverAtrLiveStrategy") {
    await fail("Wrong strategy", { strategy: config.strategyName });
  }

  console.log("[O1_LIVE_VERIFY] config", {
    symbol: config.symbol,
    resolution: config.resolution,
    dryRun: config.dryRun,
    maxOrderNotional: config.maxOrderNotional,
    strategy: config.strategyName,
    trailingForceActive: process.env.O1_TRAILING_FORCE_ACTIVE,
  });

  const before = await preflight();
  console.log("[O1_LIVE_VERIFY] preflight", before);
  if (before.positionSize !== 0) await fail("Preflight: position must be flat", before);
  if (before.openOrders !== 0) await fail("Preflight: open orders must be zero", before);
  if (before.activeTriggers !== 0) await fail("Preflight: active triggers must be zero", before);

  const restore = installCapture();
  const manager = new O1BotManager();
  let botId = "";

  try {
    botId = await manager.start();
    console.log("[O1_LIVE_VERIFY] bot started", { botId });

    const entryStart = Date.now();
    let entryAt = 0;
    let entryDiagnostics: ReturnType<O1BotManager["getDiagnostics"]> | null = null;

    while (Date.now() - entryStart < ENTRY_MAX_MS) {
      await sleep(POLL_MS);
      const diagnostics = manager.getDiagnostics(botId);
      const pos = diagnostics.account.positionSize;
      console.log("[O1_LIVE_VERIFY] waiting entry", {
        elapsedMs: Date.now() - entryStart,
        positionSize: pos,
        lastSignal: diagnostics.strategy.lastSignal,
        lastSignalReason: diagnostics.strategy.lastSignalReason,
        lastProcessedCandleTs: diagnostics.strategy.lastProcessedCandleTs,
      });
      if (pos !== 0) {
        entryAt = Date.now();
        entryDiagnostics = diagnostics;
        break;
      }
    }

    if (!entryDiagnostics || entryDiagnostics.account.positionSize === 0) {
      await manager.stop(botId);
      restore();
      await fail("No live entry within timeout", { entryMaxMs: ENTRY_MAX_MS, seenTags: [...seenTags] });
    }

    const entryPrice = entryDiagnostics.account.entryPrice;
    const entryNotional =
      Math.abs(entryDiagnostics.account.positionSize) *
      (entryPrice > 0 ? entryPrice : entryDiagnostics.market.lastPrice);
    if (entryNotional > config.maxOrderNotional + 0.5) {
      await manager.stop(botId);
      restore();
      await fail("Entry notional exceeds cap", { entryNotional, cap: config.maxOrderNotional });
    }

    console.log("[O1_LIVE_VERIFY] entry confirmed", {
      positionSize: entryDiagnostics.account.positionSize,
      entryPrice,
      entryNotional: Math.round(entryNotional * 100) / 100,
    });

    const slStart = Date.now();
    let slSummaries: O1TriggerSummary[] = [];
    while (Date.now() - slStart < SL_MAX_MS) {
      await sleep(POLL_MS);
      const snapshot = await withRetries("sl-poll", async () => {
        const { nord, user } = await getInitializedO1Client();
        const state = createInitialO1State(config);
        const executor = new O1Executor(user, config, state);
        await executor.syncAccount();
        syncO1StateFromUser(state, user, accountId, config.marketId);
        const info = await nord.getInfo();
        const market = info.markets.find((m) => m.marketId === config.marketId);
        const priceDecimals = market?.priceDecimals ?? 2;
        const sizeDecimals = market?.sizeDecimals ?? 4;
        const triggers = await fetchActiveTriggers(nord, accountId);
        return { nord, user, state, priceDecimals, sizeDecimals, triggers };
      });
      const { nord, user, state, priceDecimals, sizeDecimals, triggers } = snapshot;
      const marketTriggers = triggers.filter((t) => t.marketId === config.marketId);
      slSummaries = marketTriggers
        .filter((t) => t.kind === "stopLoss")
        .map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals));
      if (slSummaries.length >= 1 && Math.abs(state.positionSize) > 0) {
        console.log("[O1_LIVE_VERIFY] SL confirmed on exchange", { slCount: slSummaries.length, slSummaries });
        break;
      }
      const openedEntry = listEntries().find((entry) => entry.status === "opened");
      if (seenTags.has("O1_SL") && openedEntry) {
        const diag = manager.getDiagnostics(botId);
        console.log("[O1_LIVE_VERIFY] SL confirmed via bot execution", {
          triggerId: diag.strategy.activeStopLossSpec?.triggerId?.toString(),
          currentStopLoss: diag.strategy.currentStopLoss,
        });
        slSummaries = [
          {
            marketId: config.marketId,
            triggerId: 0,
            side: "unknown",
            kind: "stopLoss",
            status: "active",
            triggerPriceMantissa: 0,
            limitPriceMantissa: null,
            limitBaseSizeMantissa: null,
            limitQuoteSizeMantissa: null,
            triggerPrice: diag.strategy.currentStopLoss ?? openedEntry.stopLoss,
          },
        ];
        break;
      }
      if (seenTags.has("O1_BE") || seenTags.has("O1_TRAIL")) {
        console.log("[O1_LIVE_VERIFY] SL implied by active BE/trail management");
        break;
      }
    }

    if (slSummaries.length === 0) {
      await manager.stop(botId);
      restore();
      await fail("SL trigger not confirmed within timeout", { slMaxMs: SL_MAX_MS });
    }

    const crossovers = listCrossovers({ limit: 10 });
    const entries = listEntries({ limit: 10 });
    console.log("[O1_LIVE_VERIFY] history after entry", {
      crossoverCount: crossovers.length,
      entryCount: entries.length,
      latestCrossover: crossovers[0] ?? null,
      latestEntry: entries[0] ?? null,
    });

    if (!seenTags.has("O1_CROSSOVER_RECORDED")) {
      console.warn("[O1_LIVE_VERIFY] warn: O1_CROSSOVER_RECORDED not in captured logs (check history API)");
    }
    if (!seenTags.has("O1_ENTRY_RECORDED")) {
      console.warn("[O1_LIVE_VERIFY] warn: O1_ENTRY_RECORDED not in captured logs (check history API)");
    }

    const manageStart = Date.now();
    let slBeforeManage = slSummaries[0]?.triggerPrice;
    let sawManageUpdate = seenTags.has("O1_BE") || seenTags.has("O1_TRAIL");

    while (Date.now() - manageStart < MANAGE_MAX_MS) {
      await sleep(POLL_MS);
      const snapshot = await withRetries("manage-poll", async () => {
        const { nord, user } = await getInitializedO1Client();
        const state = createInitialO1State(config);
        const executor = new O1Executor(user, config, state);
        await executor.syncAccount();
        syncO1StateFromUser(state, user, accountId, config.marketId);
        const info = await nord.getInfo();
        const market = info.markets.find((m) => m.marketId === config.marketId);
        const priceDecimals = market?.priceDecimals ?? 2;
        const sizeDecimals = market?.sizeDecimals ?? 4;
        const triggers = await fetchActiveTriggers(nord, accountId);
        return { nord, user, state, priceDecimals, sizeDecimals, triggers };
      });
      const { state, priceDecimals, sizeDecimals, triggers } = snapshot;
      const slTriggers = triggers
        .filter((t) => t.marketId === config.marketId && t.kind === "stopLoss")
        .map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals));

      if (seenTags.has("O1_BE") || seenTags.has("O1_TRAIL")) {
        sawManageUpdate = true;
      }

      if (slTriggers.length === 1 && slBeforeManage !== undefined) {
        const newPrice = slTriggers[0]!.triggerPrice;
        const isLong = state.positionSize > 0;
        const improved = isLong ? newPrice > slBeforeManage : newPrice < slBeforeManage;
        if (improved && newPrice !== slBeforeManage) {
          sawManageUpdate = true;
          console.log("[O1_LIVE_VERIFY] SL moved favorably (forced trail/BE machinery)", {
            slBeforeManage,
            newPrice,
            isLong,
          });
        }
      }

      if (slTriggers.length > 1) {
        await fail("Duplicate SL triggers detected during manage phase", { slTriggers });
      }

      console.log("[O1_LIVE_VERIFY] manage phase", {
        elapsedMs: Date.now() - manageStart,
        sawBE: seenTags.has("O1_BE"),
        sawTrail: seenTags.has("O1_TRAIL"),
        slCount: slTriggers.length,
        slPrice: slTriggers[0]?.triggerPrice,
        trailingActive: manager.getDiagnostics(botId).strategy.trailingActive,
        breakEvenActive: manager.getDiagnostics(botId).strategy.breakEvenActive,
      });

      if (sawManageUpdate) break;
    }

    if (!sawManageUpdate) {
      console.warn(
        "[O1_LIVE_VERIFY] manage update not observed in window; proceeding to close (O1_TRAILING_FORCE_ACTIVE was enabled)"
      );
    }

    await manager.stop(botId);
    console.log("[O1_LIVE_VERIFY] bot stopped before manual close");

    const { nord, user } = await initO1Client();
    const state = createInitialO1State(config);
    const executor = new O1Executor(user, config, state);
    await executor.syncAccount();
    syncO1StateFromUser(state, user, accountId, config.marketId);

    if (state.positionSize !== 0) {
      console.log("[O1_LIVE_VERIFY] closing test position reduce-only");
      const closeResult = await executor.closePosition();
      if (!closeResult.ok) {
        await fail("Close position failed", { reason: closeResult.reason });
      }
      await sleep(3000);
      await executor.syncAccount();
      syncO1StateFromUser(state, user, accountId, config.marketId);
    }

    const info = await nord.getInfo();
    const market = info.markets.find((m) => m.marketId === config.marketId);
    const priceDecimals = market?.priceDecimals ?? 2;
    const sizeDecimals = market?.sizeDecimals ?? 4;
    const removed = await cleanupAllTriggers(nord, executor, accountId, config.marketId, priceDecimals, sizeDecimals);
    console.log("[O1_LIVE_VERIFY] triggers removed", { removed });

    const flat = await waitForAccountFlat({
      nord,
      executor,
      state,
      user,
      accountId,
      marketId: config.marketId,
      priceDecimals,
      sizeDecimals,
      requireTriggersZero: true,
      attempts: 15,
      delayMs: 2000,
    });

    if (flat.ok) {
      console.log("[O1_POSITION_CLEARED] Live verify final flat state confirmed", {
        positionSize: flat.positionSize,
        openOrders: flat.openOrders,
        activeTriggers: flat.activeTriggers,
      });
    }

    restore();

    const finalCrossovers = listCrossovers({ limit: 20 });
    const finalEntries = listEntries({ limit: 20 });

    const requiredForPass: Tag[] = [
      "O1_CANDLE_POLL",
      "O1_CLOSED_DIRECT_CANDLE",
      "O1_STRATEGY_TICK",
      "O1_ENTRY",
      "O1_SL",
      "O1_CLOSE",
      "O1_POSITION_CLEARED",
    ];
    const missingRequired = requiredForPass.filter((t) => !seenTags.has(t));

    const report = {
      success:
        missingRequired.length === 0 &&
        flat.ok &&
        finalEntries.some((e) => e.status === "opened") &&
        (seenTags.has("O1_BE") || seenTags.has("O1_TRAIL")),
      flat,
      missingRequiredTags: missingRequired,
      sawBE: seenTags.has("O1_BE"),
      sawTrail: seenTags.has("O1_TRAIL"),
      sawManageUpdate,
      entryNotional: Math.round(entryNotional * 100) / 100,
      slSummaries,
      crossoverEndpoint: { count: finalCrossovers.length, records: finalCrossovers },
      entryEndpoint: { count: finalEntries.length, records: finalEntries },
      seenTags: [...seenTags],
    };

    console.log("[O1_LIVE_VERIFY] REPORT", JSON.stringify(report, null, 2));
    console.log("[O1_LIVE_VERIFY] CAPTURED_LOGS", capturedLogs.join("\n"));

    if (!report.success) {
      await fail("Verification incomplete", report as unknown as Record<string, unknown>);
    }

    console.log("[O1_LIVE_VERIFY] PASSED");
  } catch (err) {
    restore();
    if (botId) {
      try {
        await manager.stop(botId);
      } catch {
        /* ignore */
      }
    }
    await fail("Unhandled error", { error: err instanceof Error ? err.message : String(err) });
  }
}

main().catch((err) => {
  console.error("[O1_LIVE_VERIFY] fatal", err);
  process.exit(1);
});
