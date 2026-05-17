/**
 * Phase 1 dry-run verification for emaCrossoverAtrLiveStrategy.
 */
import dotenv from "dotenv";

dotenv.config();

process.env.O1_STRATEGY = "emaCrossoverAtrLiveStrategy";
process.env.O1_DRY_RUN = "true";
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
process.env.O1_CANDLE_POLL_MS = "15000";
process.env.O1_LOG_LEVEL = "info";
process.env.O1_MANAGE_EXISTING_POSITION_ONLY = "false";

import { resetO1Client } from "../bot/exchanges/o1/client";
import { listCrossovers, listEntries } from "../bot/exchanges/o1/history";
import { O1BotManager } from "../bot/exchanges/o1/manager";

resetO1Client();

const MAX_WAIT_MS = Number(process.env.O1_DRY_TEST_MAX_MS ?? "600000");
const POLL_MS = 5000;

const requiredTags = [
  "O1_CANDLE_POLL",
  "O1_CLOSED_DIRECT_CANDLE",
  "O1_STRATEGY_TICK",
  "O1_STRATEGY_READY",
] as const;

const seen = new Set<string>();
const lines: string[] = [];

const capture = (line: string): void => {
  for (const tag of requiredTags) {
    if (line.includes(`[${tag}]`)) seen.add(tag);
  }
  if (line.includes("[O1_CROSSOVER_RECORDED]") || line.includes("[O1_ENTRY_RECORDED]")) {
    lines.push(line);
  }
};

const installCapture = (): (() => void) => {
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    capture(line);
    origLog(...args);
  };
  return () => {
    console.log = origLog;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (process.env.O1_ENABLED !== "true") {
    console.error("[O1_DRY_TEST] O1_ENABLED must be true");
    process.exit(1);
  }

  const restore = installCapture();
  const manager = new O1BotManager();
  let botId: string;

  try {
    botId = await manager.start();
    console.log("[O1_DRY_TEST] bot started", { botId });
  } catch (err) {
    restore();
    console.error("[O1_DRY_TEST] start failed", err);
    process.exit(1);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (seen.has("O1_CANDLE_POLL") && seen.has("O1_CLOSED_DIRECT_CANDLE") && seen.has("O1_STRATEGY_TICK")) {
      break;
    }
    await sleep(POLL_MS);
  }

  const diagnostics = manager.getDiagnostics(botId);
  const crossovers = listCrossovers({ limit: 5 });
  const entries = listEntries({ limit: 5 });

  await manager.stop(botId);
  restore();

  const missing = requiredTags.filter((t) => !seen.has(t));
  console.log("[O1_DRY_TEST] summary", {
    missingTags: missing,
    crossoverCount: crossovers.length,
    entryCount: entries.length,
    lastSignal: diagnostics.strategy.lastSignal,
    lastSignalReason: diagnostics.strategy.lastSignalReason,
    strategyName: diagnostics.strategy.activeStrategyName,
    poll: diagnostics.poll,
  });

  if (crossovers[0]?.details) {
    console.log("[O1_DRY_TEST] latest crossover details keys", Object.keys(crossovers[0].details));
  }

  if (missing.length > 0) {
    console.error("[O1_DRY_TEST] FAILED missing tags", missing);
    process.exit(1);
  }

  console.log("[O1_DRY_TEST] PASSED");
}

main().catch((err) => {
  console.error("[O1_DRY_TEST] fatal", err);
  process.exit(1);
});
