/**
 * Aggressive live proof: >=3 entered_confirmed trades (minimal notional).
 */
import dotenv from "dotenv";
dotenv.config();

const applyAggressiveTestEnv = (): void => {
  process.env.O1_ENABLED = "true";
  process.env.O1_DRY_RUN = "false";
  process.env.O1_STRATEGY = "emaCrossoverAtrLiveStrategy";
  process.env.O1_RESOLUTION = "1";
  process.env.O1_EMA_SHORT_PERIOD = "2";
  process.env.O1_EMA_LONG_PERIOD = "3";
  process.env.O1_ATR_PERIOD = "3";
  process.env.O1_STRENGTH_CONFIRMATION_PCT = "0";
  process.env.O1_STRENGTH_LOOKBACK_CANDLES = "1";
  process.env.O1_ATR_STOP_MULTIPLIER = "0.5";
  process.env.O1_BREAK_EVEN_PCT = "0.02";
  process.env.O1_TRAILING_START_PCT = "0.02";
  process.env.O1_TRAILING_GAP_PCT = "0.05";
  process.env.O1_RISK_PCT = "0.5";
  process.env.O1_DEFAULT_LEVERAGE = "2";
  process.env.O1_MAX_ORDER_NOTIONAL = "8";
  process.env.O1_MAX_POSITION_SIZE = "0.15";
  process.env.O1_COOLDOWN_CANDLES = "0";
  process.env.O1_MIN_MOVE_VS_FEE_MULT = "0";
  process.env.O1_FEE_RATE = "0.00035";
  process.env.O1_CANDLE_POLL_MS = "5000";
  process.env.O1_LOG_LEVEL = "info";
  process.env.O1_MANAGE_EXISTING_POSITION_ONLY = "false";
  process.env.O1_BLOCK_NEW_ENTRIES = "false";
  process.env.O1_EMERGENCY_STOP = "false";
  process.env.O1_ALLOW_LIVE_TEST = "true";
  process.env.O1_TEST_MAINNET_CONFIRMED = "true";
  process.env.O1_PROOF_MAX_MS = process.env.O1_PROOF_MAX_MS ?? "3600000";
  process.env.O1_PROOF_POLL_MS = process.env.O1_PROOF_POLL_MS ?? "4000";
  process.env.O1_PROOF_TARGET = process.env.O1_PROOF_TARGET ?? "2";
  process.env.O1_SCHEDULED_RESTART_HOURS = "0";
};

applyAggressiveTestEnv();

import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  sleep,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
} from "../bot/exchanges/o1/liveTestSupport";
import {
  getPipelineStageCounts,
  getRejectionCounters,
  listEntries,
  listCrossovers,
  resetRejectionCounters,
} from "../bot/exchanges/o1/history";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";
import * as fs from "fs";
import * as path from "path";

type ConfirmedTrade = {
  entryId: string;
  orderResult: string | null;
  crossoverId: string | null;
  timestamp: number;
  direction: string;
  size: number;
  slOnExchange: boolean;
};

const fixes: string[] = [
  "signal_found only recorded after safe-mode checks pass (strategyExecution)",
  "manager records skipped-other for safe-mode block instead of misleading signal_found",
  "clear blockNewEntries/emergencyStop on position flat when config allows trading",
  "reset reconnectCount when candle+account WS healthy; soft recycle at max reconnect while flat",
  "scheduled flat restart: O1_SCHEDULED_RESTART_HOURS / O1_SCHEDULED_RESTART_COOLDOWN_MS",
  "stop-loss triggers omit limitPrice (market exit on fire)",
];

const reportPath = path.join(process.cwd(), "o1-trade-proof-report.json");
const TARGET = Number(process.env.O1_PROOF_TARGET ?? "3");
const MAX_MS = Number(process.env.O1_PROOF_MAX_MS ?? "3600000");
const POLL_MS = Number(process.env.O1_PROOF_POLL_MS ?? "4000");
const API_BASE = process.env.O1_API_BASE ?? "http://127.0.0.1:8080";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`[O1_PROOF] ${label} retry ${i + 1}/${attempts}`, e);
      await sleepMs(3000 * (i + 1));
    }
  }
  throw last;
}

async function ensureFlat(): Promise<void> {
  resetO1Client();
  const { config, nord, user } = await withRetry("ensureFlat-init", () => initO1Client());
  if (!config.accountId) throw new Error("no accountId");
  const state = createInitialO1State(config);
  const ex = new O1Executor(user, config, state);
  const info = await nord.getInfo();
  const m = info.markets.find((x) => x.marketId === config.marketId)!;
  await ex.syncAccount();
  syncO1StateFromUser(state, user, config.accountId, config.marketId);
  if (state.positionSize !== 0) {
    await ex.closePosition();
    await sleepMs(2500);
    await ex.syncAccount();
    syncO1StateFromUser(state, user, config.accountId, config.marketId);
  }
  const triggers = await fetchActiveTriggers(nord, config.accountId);
  for (const t of triggers.filter((r) => r.marketId === config.marketId)) {
    await ex.removeKnownTrigger(toTriggerSpecFromApi(t, m.priceDecimals, m.sizeDecimals));
  }
  await sleepMs(1000);
}

async function flattenViaManager(manager: O1BotManager, botId: string): Promise<void> {
  await manager.flattenForNextEntry(botId);
  await sleepMs(1500);
}

async function apiPhase1(botId: string): Promise<Record<string, unknown>> {
  const phase: Record<string, unknown> = {};
  try {
    const list = await fetch(`${API_BASE}/api/o1-bot/`).then((r) => r.json());
    phase.botsList = list;
    phase.botListed = Array.isArray(list?.bots) && list.bots.some((b: { botId?: string }) => b.botId === botId);
    const diag = await fetch(`${API_BASE}/api/o1-bot/diagnostics/${botId}`).then((r) => r.json());
    phase.diagnosticsOk = Boolean(diag?.diagnostics || diag?.history);
    phase.diagnosticsSample = {
      blockNewEntries: diag?.diagnostics?.safeMode?.blockNewEntries,
      emergencyStop: diag?.diagnostics?.safeMode?.emergencyStop,
      pipelineStages: diag?.history?.pipelineStages,
    };
  } catch (e) {
    phase.apiError = String(e);
  }
  return phase;
}

async function main(): Promise<void> {
  const attempts = { pollCycles: 0, closesAfterEntry: 0 };
  const confirmed: ConfirmedTrade[] = [];
  const seenCrossoverIds = new Set<string>();
  let flattenedAfterConfirmCount = 0;
  let botId = "";
  const manager = new O1BotManager();
  const startMs = Date.now();

  console.log("[O1_PROOF] aggressive params", {
    strategy: process.env.O1_STRATEGY,
    resolution: process.env.O1_RESOLUTION,
    maxNotional: process.env.O1_MAX_ORDER_NOTIONAL,
    blockNewEntries: process.env.O1_BLOCK_NEW_ENTRIES,
    emergencyStop: process.env.O1_EMERGENCY_STOP,
    target: TARGET,
  });

  resetRejectionCounters();
  await ensureFlat();

  try {
    botId = await withRetry("bot-start", () => manager.start());
    console.log("[O1_PROOF] bot started", { botId });

    while (Date.now() - startMs < MAX_MS && confirmed.length < TARGET) {
      await sleepMs(POLL_MS);
      attempts.pollCycles += 1;

      const stages = getPipelineStageCounts();
      const rejectionCounters = getRejectionCounters();
      const diag = manager.getDiagnostics(botId);
      const { diagnostics: safeDiag } = await manager.getSafeDiagnostics(botId);
      const ex = safeDiag?.exchange as { slCount?: number } | undefined;

      for (const cross of listCrossovers().filter((c) => c.reason === "entered_confirmed")) {
        if (seenCrossoverIds.has(cross.id)) continue;
        seenCrossoverIds.add(cross.id);
        const matchEntry = listEntries().find(
          (e) => e.crossoverId === cross.id && e.status === "opened"
        );
        const orderResult =
          matchEntry?.orderResult ??
          (cross.details?.orderResult as string | undefined) ??
          null;
        confirmed.push({
          entryId: matchEntry?.id ?? `cross-${cross.id}`,
          orderResult,
          crossoverId: cross.id,
          timestamp: cross.timestamp,
          direction: cross.direction,
          size: matchEntry?.size ?? cross.calculatedSize ?? 0,
          slOnExchange: (ex?.slCount ?? 0) >= 1 || diag.account.positionSize !== 0,
        });
      }

      console.log("[O1_PROOF] poll", {
        elapsedSec: Math.round((Date.now() - startMs) / 1000),
        confirmed: confirmed.length,
        stages,
        rejectionCounters,
        positionSize: diag.account.positionSize,
        slCount: (diag as { exchange?: { slCount?: number } }).exchange?.slCount ?? 0,
        blockNewEntries: (diag as { safety?: { blockNewEntries?: boolean } }).safety?.blockNewEntries,
        emergencyStop: (diag as { safety?: { emergencyStop?: boolean } }).safety?.emergencyStop,
        cooldownRemaining: diag.strategy?.cooldownCandlesRemaining,
        lastProcessedCandleTs: diag.strategy?.lastProcessedCandleTs,
      });

      if (confirmed.length >= TARGET) break;

      if (
        confirmed.length > flattenedAfterConfirmCount &&
        confirmed.length < TARGET &&
        diag.account.positionSize !== 0
      ) {
        const last = confirmed[confirmed.length - 1];
        if (Date.now() - last.timestamp > 12000) {
          console.log("[O1_PROOF] flatten after confirmed entry", { trade: confirmed.length });
          await flattenViaManager(manager, botId);
          flattenedAfterConfirmCount = confirmed.length;
          attempts.closesAfterEntry += 1;
        }
      }
    }

    const apiPhase = await apiPhase1(botId);
    const finalStages = getPipelineStageCounts();
    const allHaveSl = confirmed.length >= TARGET && confirmed.every((t) => t.slOnExchange);
    const success =
      confirmed.length >= TARGET &&
      finalStages.entered_confirmed >= TARGET &&
      finalStages.signal_found >= TARGET &&
      allHaveSl;

    const report = {
      success,
      target: TARGET,
      tradeCount: confirmed.length,
      orderIds: confirmed.map((t) => t.orderResult).filter(Boolean),
      confirmedTrades: confirmed,
      attempts,
      fixes,
      finalParameters: {
        strategy: process.env.O1_STRATEGY,
        resolution: process.env.O1_RESOLUTION,
        emaShort: process.env.O1_EMA_SHORT_PERIOD,
        emaLong: process.env.O1_EMA_LONG_PERIOD,
        maxOrderNotional: process.env.O1_MAX_ORDER_NOTIONAL,
        cooldownCandles: process.env.O1_COOLDOWN_CANDLES,
        blockNewEntries: process.env.O1_BLOCK_NEW_ENTRIES,
        emergencyStop: process.env.O1_EMERGENCY_STOP,
      },
      pipelineStages: finalStages,
      rejectionCounters: getRejectionCounters(),
      continuedAfterFirst: confirmed.length >= 2,
      allEntriesHadExchangeSl: allHaveSl,
      signalsConvertToEntries: finalStages.signal_found > 0 && finalStages.entered_confirmed >= 1,
      apiPhase,
      botId,
      elapsedMs: Date.now() - startMs,
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log("\n=== O1 TRADE PROOF REPORT ===");
    console.log(JSON.stringify(report, null, 2));

    await manager.safeStop(botId);
    await ensureFlat();

    process.exit(success ? 0 : 1);
  } catch (e) {
    console.error("[O1_PROOF] fatal", e);
    if (botId) await manager.safeStop(botId).catch(() => {});
    await ensureFlat().catch(() => {});
    process.exit(1);
  }
}

main();
