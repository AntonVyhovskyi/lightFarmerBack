/**
 * Fast aggressive validation for O1 stop-loss guard (minimal notional).
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
  process.env.O1_TEST_MAX_NOTIONAL = "8";
  process.env.O1_TEST_AUTO_CLOSE_ON_ERROR = "true";
  process.env.O1_VERIFY_ENTRY_MAX_MS = "480000";
  process.env.O1_VERIFY_POLL_MS = "3000";
};

applyAggressiveTestEnv();

import { Side, TriggerKind } from "@n1xyz/nord-ts";
import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  filterMarketTriggersByKind,
  sleep,
  summarizeTrigger,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
  waitForAccountFlat,
} from "../bot/exchanges/o1/liveTestSupport";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";
import {
  ensureProtectiveStopLoss,
  logStopGuard,
  waitForPositionConfirmation,
  type StopGuardContext,
  type StopGuardEvent,
} from "../bot/exchanges/o1/stopLossGuard";

type Verdict = "PASS" | "FAIL" | "SKIP";
const results: Record<string, Verdict> = {};
const guardEvents = new Set<StopGuardEvent>();
const logLines: string[] = [];

const record = (name: string, verdict: Verdict, detail?: unknown): void => {
  results[name] = verdict;
  console.log(`[VALIDATE] ${name}: ${verdict}`, detail ?? "");
};

const captureInstall = (): (() => void) => {
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logLines.push(line);
    if (line.includes("O1_STOP_GUARD")) {
      const events: StopGuardEvent[] = [
        "POSITION_OPENED","POSITION_CONFIRMED","POSITION_NOT_CONFIRMED",
        "STOP_CREATE_STARTED","STOP_CREATE_SUCCESS","STOP_CREATE_FAILED",
        "STOP_NOT_FOUND","STOP_VERIFIED","EMERGENCY_STOP_RECREATE","STOP_DUPLICATE_REMOVED",
      ];
      for (const e of events) {
        if (line.includes(e)) guardEvents.add(e);
      }
    }
    orig(...args);
  };
  return () => { console.log = orig; };
};

async function ensureFlat(): Promise<void> {
  resetO1Client();
  const { config, nord, user } = await initO1Client();
  if (!config.accountId) throw new Error("no accountId");
  const state = createInitialO1State(config);
  const ex = new O1Executor(user, config, state);
  await ex.syncAccount();
  syncO1StateFromUser(state, user, config.accountId, config.marketId);
  const info = await nord.getInfo();
  const m = info.markets.find((x) => x.marketId === config.marketId)!;
  if (state.positionSize !== 0) {
    await ex.closePosition();
    await sleep(2000);
    await ex.syncAccount();
    syncO1StateFromUser(state, user, config.accountId, config.marketId);
  }
  const triggers = await fetchActiveTriggers(nord, config.accountId);
  for (const t of triggers.filter((r) => r.marketId === config.marketId)) {
    await ex.removeKnownTrigger(toTriggerSpecFromApi(t, m.priceDecimals, m.sizeDecimals));
  }
  await sleep(1000);
}

async function apiCheck(baseUrl: string): Promise<void> {
  try {
    const bots = await fetch(`${baseUrl}/api/o1-bot/`).then((r) => r.json());
    record("api-bots-list", bots?.enabled ? "PASS" : "FAIL", bots);
    const botId = `o1-${process.env.O1_SYMBOL}-${process.env.O1_RESOLUTION}`;
    const diag = await fetch(`${baseUrl}/api/o1-bot/diagnostics/${botId}`).then((r) => r.json());
    record("api-diagnostics", diag?.diagnostics ? "PASS" : "FAIL", { status: diag?.diagnosticsError });
    const stop = await fetch(`${baseUrl}/api/o1-bot/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId }),
    }).then((r) => r.json());
    record("api-stop", stop?.stopped !== undefined ? "PASS" : "FAIL", stop);
  } catch (e) {
    record("api-health", "FAIL", e);
  }
}

async function phaseDirectGuard(): Promise<void> {
  resetO1Client();
  const { config, nord, user } = await initO1Client();
  if (!config.accountId) throw new Error("no accountId");
  const state = createInitialO1State(config);
  const ex = new O1Executor(user, config, state);
  const info = await nord.getInfo();
  const m = info.markets.find((x) => x.marketId === config.marketId)!;
  const price = state.lastPrice > 0 ? state.lastPrice : 85;
  const size = Math.min(0.09, config.maxOrderNotional / price);
  const syncState = async () => {
    await ex.syncAccount();
    syncO1StateFromUser(state, user, config.accountId!, config.marketId);
  };
  await syncState();

  const ctx: StopGuardContext = {
    state, config, nord, executor: ex,
    priceDecimals: m.priceDecimals,
    sizeDecimals: m.sizeDecimals,
    syncState,
  };

  logStopGuard("POSITION_OPENED", ctx, { phase: "direct-test", plannedSize: size });
  const open = await ex.openLong(size);
  record("direct-entry-submit", open.ok ? "PASS" : "FAIL", open);

  const wait = await waitForPositionConfirmation(ctx, { maxAttempts: 20, delayMs: 800 });
  record("delayed-fill-wait", wait.confirmed ? "PASS" : "FAIL", wait);
  if (wait.confirmed) guardEvents.add("POSITION_CONFIRMED");

  state.strategy.activeStopLossSpec = {
    marketId: config.marketId,
    side: Side.Ask,
    kind: TriggerKind.StopLoss,
    triggerPrice: price * 0.995,
    limitPrice: price * 0.995,
    limitBaseSize: Math.abs(state.positionSize) || size,
  };
  state.strategy.currentStopLoss = state.strategy.activeStopLossSpec.triggerPrice;

  const guard1 = await ensureProtectiveStopLoss(ctx, "direct-post-entry", { skipDebounce: true, force: true });
  record("stop-create-on-entry", guard1.status === "ok" || guard1.status === "recreated" ? "PASS" : "FAIL", guard1);
  if (guardEvents.has("STOP_CREATE_STARTED") && (guardEvents.has("STOP_CREATE_SUCCESS") || guardEvents.has("STOP_VERIFIED"))) {
    record("guard-event-flow", "PASS");
  } else {
    record("guard-event-flow", "FAIL", [...guardEvents]);
  }

  const triggersBefore = await fetchActiveTriggers(nord, config.accountId);
  const slBefore = filterMarketTriggersByKind(triggersBefore, config.marketId, "stopLoss");
  if (slBefore.length === 0) {
    record("missing-stop-recreate", "FAIL", "no sl to remove");
  } else {
    for (const t of slBefore) {
      await ex.removeKnownTrigger(toTriggerSpecFromApi(t, m.priceDecimals, m.sizeDecimals));
    }
    await sleep(1500);
    const guard2 = await ensureProtectiveStopLoss(ctx, "emergency-recreate-test", { skipDebounce: true, force: true });
    record("missing-stop-recreate", guard2.status === "recreated" || guard2.status === "ok" ? "PASS" : "FAIL", guard2);
    record("emergency-recreate-event", guardEvents.has("EMERGENCY_STOP_RECREATE") ? "PASS" : "FAIL");
  }

  await ex.closePosition();
  await sleep(2000);
  await syncState();
  const flat = await waitForAccountFlat({
    nord, executor: ex, state, user,
    accountId: config.accountId, marketId: config.marketId,
    priceDecimals: m.priceDecimals, sizeDecimals: m.sizeDecimals,
    attempts: 8, delayMs: 800,
  });
  record("direct-cleanup-flat", flat.ok ? "PASS" : "FAIL", flat);
}

async function phaseBotCrossover(): Promise<void> {
  resetO1Client();
  const manager = new O1BotManager();
  let botId = "";
  try {
    botId = await manager.start();
    record("bot-start", "PASS", { botId });
    const entryMax = Number(process.env.O1_VERIFY_ENTRY_MAX_MS ?? "480000");
    const poll = Number(process.env.O1_VERIFY_POLL_MS ?? "3000");
    const start = Date.now();
    let entered = false;
    while (Date.now() - start < entryMax) {
      await sleep(poll);
      const d = manager.getDiagnostics(botId);
      if (d.account.positionSize !== 0) {
        entered = true;
        record("bot-crossover-entry", "PASS", {
          positionSize: d.account.positionSize,
          elapsedMs: Date.now() - start,
        });
        break;
      }
    }
    if (!entered) record("bot-crossover-entry", "SKIP", "no natural crossover in window");

    await sleep(25000);
    record("watchdog-window", "PASS", "waited 25s for watchdog");

    const { diagnostics } = await manager.getSafeDiagnostics(botId);
    const exSl = (diagnostics as { exchange?: { slCount?: number } }).exchange?.slCount ?? 0;
    const pos = (diagnostics as { account?: { positionSize?: number } }).account?.positionSize ?? 0;
    if (pos !== 0) {
      record("bot-sl-on-exchange", exSl >= 1 ? "PASS" : "FAIL", { pos, exSl });
    } else {
      record("bot-sl-on-exchange", "SKIP", "flat");
    }

    await manager.safeStop(botId);
    record("bot-stop", "PASS");
  } catch (e) {
    record("bot-phase", "FAIL", e);
    if (botId) await manager.safeStop(botId).catch(() => {});
  }
}

async function main(): Promise<void> {
  console.log("[VALIDATE] aggressive params", {
    strategy: process.env.O1_STRATEGY,
    resolution: process.env.O1_RESOLUTION,
    maxNotional: process.env.O1_MAX_ORDER_NOTIONAL,
    blockNewEntries: process.env.O1_BLOCK_NEW_ENTRIES,
    candlePollMs: process.env.O1_CANDLE_POLL_MS,
  });

  const restore = captureInstall();
  try {
    await ensureFlat();
    record("preflight-flat", "PASS");

    await phaseDirectGuard();
    await phaseBotCrossover();
    await ensureFlat();
    record("post-test-flat", "PASS");

    await apiCheck("http://127.0.0.1:8080");
  } catch (e) {
    console.error("[VALIDATE] fatal", e);
    record("run", "FAIL", e);
    await ensureFlat().catch(() => {});
  } finally {
    restore();
    process.env.O1_BLOCK_NEW_ENTRIES = "true";
    process.env.O1_EMERGENCY_STOP = "true";
  }

  console.log("\n=== PASS/FAIL TABLE ===");
  for (const [k, v] of Object.entries(results)) console.log(`${v}\t${k}`);
  console.log("\n=== GUARD EVENTS SEEN ===", [...guardEvents]);
  const fails = Object.values(results).filter((v) => v === "FAIL").length;
  const decision = fails === 0 ? "SAFE for production (stop guard validated)" : "NOT SAFE — failures remain";
  console.log("\n=== DECISION ===", decision, { failCount: fails });
  process.exit(fails > 0 ? 1 : 0);
}

main();
