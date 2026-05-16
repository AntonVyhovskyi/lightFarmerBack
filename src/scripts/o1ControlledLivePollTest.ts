/**
 * Controlled live execution: polling-driven candles, one entry max, capped notional.
 */
import dotenv from "dotenv";
import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { readO1Env } from "../bot/exchanges/o1/env";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  summarizeTrigger,
  syncO1StateFromUser,
} from "../bot/exchanges/o1/liveTestSupport";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";

dotenv.config();
resetO1Client();

const MAX_WAIT_MS = Number(process.env.O1_CONTROLLED_TEST_MAX_MS ?? String(45 * 60_000));
const POLL_MS = Number(process.env.O1_CONTROLLED_TEST_POLL_MS ?? "5000");
const STRATEGY_TICK_DEADLINE_MS = Number(process.env.O1_CONTROLLED_TEST_TICK_DEADLINE_MS ?? "180000");
const SL_WAIT_MS = Number(process.env.O1_CONTROLLED_TEST_SL_WAIT_MS ?? "90000");

const IMPORTANT_TAGS = [
  "O1_CANDLE_POLL",
  "O1_CLOSED_DIRECT_CANDLE",
  "O1_STRATEGY_TICK",
  "O1_ENTRY",
  "O1_SL",
  "O1_STRATEGY_ERROR",
] as const;

const importantLogs: string[] = [];
let sawCandlePoll = false;
let sawClosedDirectPoll = false;
let sawStrategyTick = false;

const captureLine = (line: string): void => {
  for (const tag of IMPORTANT_TAGS) {
    if (line.includes(`[${tag}]`)) {
      importantLogs.push(line);
      if (tag === "O1_CANDLE_POLL") sawCandlePoll = true;
      if (tag === "O1_CLOSED_DIRECT_CANDLE" && line.includes('"source":"poll"')) {
        sawClosedDirectPoll = true;
      }
      if (tag === "O1_STRATEGY_TICK") sawStrategyTick = true;
    }
  }
};

const installLogCapture = (): (() => void) => {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    captureLine(line);
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    captureLine(line);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    captureLine(line);
    origError(...args);
  };

  return () => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = async (
  reason: string,
  extra: Record<string, unknown>,
  opts?: { manager?: O1BotManager; botId?: string; executor?: O1Executor }
): Promise<never> => {
  if (opts?.executor && opts.manager && opts.botId) {
    try {
      await opts.executor.closePosition();
    } catch {
      // best effort
    }
    try {
      await opts.manager.stop(opts.botId);
    } catch {
      // best effort
    }
  }
  console.error("[O1_CONTROLLED_TEST_FAIL]", { reason, ...extra });
  console.log("[O1_CONTROLLED_TEST] important logs", importantLogs.slice(-40));
  process.exit(1);
};

async function preflight(): Promise<{
  positionSize: number;
  openOrders: number;
  activeTriggers: number;
}> {
  const { config, nord, user } = await initO1Client();
  if (!config.accountId) throw new Error("Missing O1 accountId");
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
}

async function main(): Promise<void> {
  if (process.env.O1_ALLOW_LIVE_TEST !== "true" || process.env.O1_TEST_MAINNET_CONFIRMED !== "true") {
    await fail("Set O1_ALLOW_LIVE_TEST=true and O1_TEST_MAINNET_CONFIRMED=true", {});
  }

  const config = readO1Env();
  if (config.dryRun) await fail("O1_DRY_RUN must be false", { dryRun: config.dryRun });

  console.log("[O1_CONTROLLED_TEST] config", {
    symbol: config.symbol,
    resolution: config.resolution,
    dryRun: config.dryRun,
    candlePollMs: config.candlePollIntervalMs,
    maxOrderNotional: config.maxOrderNotional,
    leverage: config.strategyParams.leverage,
    strategy: config.strategyName,
  });

  const before = await preflight();
  console.log("[O1_CONTROLLED_TEST] preflight", before);
  if (before.positionSize !== 0) await fail("Preflight: position must be flat", before);
  if (before.openOrders !== 0) await fail("Preflight: open orders must be zero", before);
  if (before.activeTriggers !== 0) await fail("Preflight: active triggers must be zero", before);

  const restoreLogs = installLogCapture();
  const manager = new O1BotManager();
  let botId = "";
  let executor: O1Executor | undefined;

  try {
    botId = await manager.start();
    console.log("[O1_CONTROLLED_TEST] bot started", { botId });

    const startedAt = Date.now();
    let entryDetected = false;
    let entryAt = 0;

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await sleep(POLL_MS);

      const elapsed = Date.now() - startedAt;
      const diagnostics = manager.getDiagnostics(botId);

      if (!sawStrategyTick && elapsed > STRATEGY_TICK_DEADLINE_MS) {
        await fail("Strategy did not tick from polling within deadline", {
          sawCandlePoll,
          sawClosedDirectPoll,
          sawStrategyTick,
          lastCandleUpdateAt: diagnostics.ws.lastCandleUpdateAt,
          lastProcessedCandleTs: diagnostics.strategy.lastProcessedCandleTs,
          candleCacheSize: diagnostics.market.candleCacheSize,
        }, { manager, botId });
      }

      if (entryDetected) {
        const slElapsed = Date.now() - entryAt;
        const { config: cfg, nord, user } = await initO1Client();
        if (!cfg.accountId) await fail("Missing accountId after entry", {}, { manager, botId, executor });
        const state = createInitialO1State(cfg);
        executor = new O1Executor(user, cfg, state);
        await executor.syncAccount();
        syncO1StateFromUser(state, user, cfg.accountId, cfg.marketId);

        const info = await nord.getInfo();
        const market = info.markets.find((m) => m.marketId === cfg.marketId);
        const priceDecimals = market?.priceDecimals ?? 2;
        const sizeDecimals = market?.sizeDecimals ?? 4;
        const triggers = await fetchActiveTriggers(nord, cfg.accountId);
        const marketTriggers = triggers.filter((t) => t.marketId === cfg.marketId);
        const slTriggers = marketTriggers.filter((t) => t.kind === "stopLoss");

        if (slTriggers.length > 0 || slElapsed >= SL_WAIT_MS) {
          const success = slTriggers.length > 0 && Math.abs(state.positionSize) > 0;
          if (!success) {
            await executor.closePosition();
            await manager.stop(botId);
            restoreLogs();
            await fail("Entry without verified SL trigger", {
              positionSize: state.positionSize,
              slTriggers: marketTriggers.map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals)),
              slWaitMs: slElapsed,
            });
          }

          await manager.stop(botId);
          restoreLogs();

          await executor.syncAccount();
          syncO1StateFromUser(state, user, cfg.accountId, cfg.marketId);

          const actualNotional =
            Math.abs(state.positionSize) *
            (state.entryPrice > 0 ? state.entryPrice : diagnostics.market.lastPrice);

          const report = {
            success: true,
            pollingReplacedSilentWs: sawCandlePoll && sawClosedDirectPoll && sawStrategyTick,
            sawCandlePoll,
            sawClosedDirectPoll,
            sawStrategyTick,
            actualOrderNotional: Math.round(actualNotional * 100) / 100,
            configuredMaxNotional: cfg.maxOrderNotional,
            leverageUsed: cfg.strategyParams.leverage,
            positionSize: state.positionSize,
            entryPrice: state.entryPrice,
            openOrders: state.orders.length,
            activeTriggers: marketTriggers.length,
            slTriggers: slTriggers.map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals)),
            finalDiagnostics: diagnostics,
          };

          console.log("[O1_CONTROLLED_TEST] REPORT", JSON.stringify(report, null, 2));
          console.log("[O1_CONTROLLED_TEST] important logs", importantLogs);
          return;
        }
        continue;
      }

      console.log("[O1_CONTROLLED_TEST] monitor", {
        elapsedMs: elapsed,
        positionSize: diagnostics.account.positionSize,
        lastCandleUpdateAt: diagnostics.ws.lastCandleUpdateAt,
        lastProcessedCandleTs: diagnostics.strategy.lastProcessedCandleTs,
        lastSignal: diagnostics.strategy.lastSignal,
        sawCandlePoll,
        sawClosedDirectPoll,
        sawStrategyTick,
      });

      if (diagnostics.account.positionSize !== 0) {
        entryDetected = true;
        entryAt = Date.now();
        console.log("[O1_CONTROLLED_TEST] live entry detected — waiting for SL verification");
      }
    }

    await manager.stop(botId);
    restoreLogs();
    await fail("No live entry within timeout", {
      sawCandlePoll,
      sawClosedDirectPoll,
      sawStrategyTick,
      maxWaitMs: MAX_WAIT_MS,
    });
  } catch (error) {
    restoreLogs();
    if (botId) {
      try {
        await manager.stop(botId);
      } catch {
        // ignore
      }
    }
    if (executor) {
      try {
        await executor.closePosition();
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("[O1_CONTROLLED_TEST] fatal", error);
  console.log("[O1_CONTROLLED_TEST] important logs", importantLogs.slice(-40));
  process.exit(1);
});
