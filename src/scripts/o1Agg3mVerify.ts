import dotenv from "dotenv";
import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import {
  fetchActiveTriggers,
  summarizeTrigger,
  syncO1StateFromUser,
} from "../bot/exchanges/o1/liveTestSupport";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";

dotenv.config();

const MAX_WAIT_MS = Number(process.env.O1_AGG3M_VERIFY_MAX_MS ?? String(15 * 60_000));
const POLL_MS = Number(process.env.O1_AGG3M_VERIFY_POLL_MS ?? "5000");
const TICK_DEADLINE_MS = Number(process.env.O1_AGG3M_VERIFY_TICK_DEADLINE_MS ?? String(8 * 60_000));

const REQUIRED_TAGS = [
  "O1_CANDLE_MODE",
  "O1_CANDLE_PRELOAD_AGGREGATED",
  "O1_CANDLE_POLL",
  "O1_CLOSED_3M_CANDLE",
  "O1_STRATEGY_TICK",
] as const;

const importantLogs: string[] = [];
const processedCandleTs = new Set<number>();
const tickCountByTs = new Map<number, number>();
const cacheSizeSamples: number[] = [];
const closed3mEvents: Array<{ ts: number; source: string; cacheSize: number }> = [];

let sawCandleMode = false;
let sawPreloadAggregated = false;
let sawCandlePoll = false;
let sawClosed3mPoll = false;
let sawStrategyTick = false;

const captureLine = (line: string): void => {
  for (const tag of REQUIRED_TAGS) {
    if (!line.includes("[" + tag + "]")) continue;
    importantLogs.push(line);
    if (tag === "O1_CANDLE_MODE") sawCandleMode = true;
    if (tag === "O1_CANDLE_PRELOAD_AGGREGATED") sawPreloadAggregated = true;
    if (tag === "O1_CANDLE_POLL") sawCandlePoll = true;
    if (tag === "O1_CLOSED_3M_CANDLE") {
      const source = line.includes('"source":"poll"') ? "poll" : line.includes('"source":"ws"') ? "ws" : "unknown";
      const tsMatch = line.match(/"latestClosed3mCandleTs":(\d+)/);
      const cacheMatch = line.match(/"effective3mCandleCacheSize":(\d+)/);
      closed3mEvents.push({
        ts: tsMatch ? Number(tsMatch[1]) : 0,
        source,
        cacheSize: cacheMatch ? Number(cacheMatch[1]) : 0,
      });
      if (source === "poll") sawClosed3mPoll = true;
    }
    if (tag === "O1_STRATEGY_TICK") {
      sawStrategyTick = true;
      const tsMatch = line.match(/"closedCandleTs":(\d+)/);
      if (tsMatch) {
        const ts = Number(tsMatch[1]);
        processedCandleTs.add(ts);
        tickCountByTs.set(ts, (tickCountByTs.get(ts) ?? 0) + 1);
      }
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

async function preflight(): Promise<{ positionSize: number; slCount: number; manageOnly: boolean }> {
  resetO1Client();
  const { config, nord, user } = await initO1Client();
  if (!config.accountId) throw new Error("Missing accountId");
  const state = createInitialO1State(config);
  syncO1StateFromUser(state, user, config.accountId, config.marketId);
  const triggers = await fetchActiveTriggers(nord, config.accountId);
  const sl = triggers.filter((t) => t.marketId === config.marketId && t.kind === "stopLoss");
  return { positionSize: state.positionSize, slCount: sl.length, manageOnly: state.positionSize !== 0 };
}

async function main(): Promise<void> {
  process.env.O1_RESOLUTION = "3";
  process.env.O1_LOG_LEVEL = "info";
  process.env.O1_DRY_RUN = "false";

  const pre = await preflight();
  process.env.O1_MANAGE_EXISTING_POSITION_ONLY = pre.manageOnly ? "true" : "false";
  console.log("[O1_AGG3M_VERIFY] preflight", pre);

  const restoreLogs = installLogCapture();
  resetO1Client();
  const manager = new O1BotManager();
  let botId = "";
  let initialPreloadCount = 0;

  try {
    botId = await manager.start();
    const startedAt = Date.now();
    initialPreloadCount = manager.getDiagnostics(botId).market.preloadedCandleCount;
    console.log("[O1_AGG3M_VERIFY] started", { botId, initialPreloadCount, manageOnly: pre.manageOnly });

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const d = manager.getDiagnostics(botId);
      cacheSizeSamples.push(d.market.candleCacheSize);
      const duplicateTicks = [...tickCountByTs.values()].some((c) => c > 1);
      const ready =
        sawCandleMode &&
        sawPreloadAggregated &&
        sawCandlePoll &&
        sawClosed3mPoll &&
        sawStrategyTick &&
        d.candles.configuredResolution === "3" &&
        d.candles.effectiveResolution === "3" &&
        d.candles.candleMode === "aggregated" &&
        d.candles.streamResolution === "1" &&
        d.market.candleCacheSize >= Math.max(50, initialPreloadCount - 5) &&
        closed3mEvents.length >= 1 &&
        !duplicateTicks;
      if (ready && (closed3mEvents.length >= 2 || Date.now() - startedAt > TICK_DEADLINE_MS)) break;
      if (Date.now() - startedAt > TICK_DEADLINE_MS && !sawStrategyTick) break;
    }

    const finalDiagnostics = manager.getDiagnostics(botId);
    await manager.stop(botId);
    restoreLogs();

    resetO1Client();
    const { config, nord, user } = await initO1Client();
    if (!config.accountId) throw new Error("Missing accountId");
    const state = createInitialO1State(config);
    syncO1StateFromUser(state, user, config.accountId, config.marketId);
    const info = await nord.getInfo();
    const market = info.markets.find((m) => m.marketId === config.marketId);
    const pd = market?.priceDecimals ?? 2;
    const sd = market?.sizeDecimals ?? 4;
    const slTriggers = (await fetchActiveTriggers(nord, config.accountId))
      .filter((t) => t.marketId === config.marketId && t.kind === "stopLoss")
      .map((t) => summarizeTrigger(t, pd, sd));

    const minCache = cacheSizeSamples.length ? Math.min(...cacheSizeSamples) : 0;
    const maxCache = cacheSizeSamples.length ? Math.max(...cacheSizeSamples) : 0;
    const cacheCollapsed = maxCache > 0 && minCache < Math.max(20, initialPreloadCount * 0.5);
    const duplicateTickTs = [...tickCountByTs.values()].some((c) => c > 1);
    const success =
      sawCandleMode &&
      sawPreloadAggregated &&
      sawCandlePoll &&
      sawClosed3mPoll &&
      sawStrategyTick &&
      finalDiagnostics.candles.configuredResolution === "3" &&
      finalDiagnostics.candles.effectiveResolution === "3" &&
      finalDiagnostics.candles.candleMode === "aggregated" &&
      finalDiagnostics.candles.streamResolution === "1" &&
      !cacheCollapsed &&
      !duplicateTickTs &&
      closed3mEvents.length >= 1;

    console.log(
      "[O1_AGG3M_VERIFY] REPORT",
      JSON.stringify(
        {
          success,
          preflight: pre,
          requiredLogs: {
            O1_CANDLE_MODE: sawCandleMode,
            O1_CANDLE_PRELOAD_AGGREGATED: sawPreloadAggregated,
            O1_CANDLE_POLL: sawCandlePoll,
            O1_CLOSED_3M_CANDLE: closed3mEvents.length > 0,
            O1_CLOSED_3M_CANDLE_from_poll: sawClosed3mPoll,
            O1_STRATEGY_TICK: sawStrategyTick,
          },
          closed3mEvents,
          processedCandleTs: [...processedCandleTs],
          duplicateTickTs,
          cacheSizeSamples: { min: minCache, max: maxCache, initialPreloadCount, collapsed: cacheCollapsed },
          finalDiagnostics,
          finalAccount: { positionSize: state.positionSize, slCount: slTriggers.length, slTriggers },
          productionSafe: success,
          importantLogs,
        },
        null,
        2
      )
    );
    if (!success) process.exit(1);
  } catch (error) {
    restoreLogs();
    if (botId) {
      try {
        await manager.stop(botId);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("[O1_AGG3M_VERIFY] fatal", error);
  process.exit(1);
});
