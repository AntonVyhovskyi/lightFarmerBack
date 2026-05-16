/**
 * Controlled live trailing verification on an existing open position.
 * Requires O1_MANAGE_EXISTING_POSITION_ONLY=true and flat entry path disabled.
 */
import dotenv from "dotenv";
import { getInitializedO1Client, initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { readO1Env } from "../bot/exchanges/o1/env";
import {
  fetchActiveTriggers,
  summarizeTrigger,
  syncO1StateFromUser,
} from "../bot/exchanges/o1/liveTestSupport";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { createInitialO1State } from "../bot/exchanges/o1/state";

dotenv.config();

const PHASE_MAX_MS = Number(process.env.O1_TRAIL_VERIFY_PHASE_MS ?? String(20 * 60_000));
const POLL_MS = Number(process.env.O1_TRAIL_VERIFY_POLL_MS ?? "5000");

const TRAIL_TAGS = [
  "O1_TRAIL",
  "O1_SL",
  "O1_HYDRATE",
  "O1_MANAGE_ONLY",
  "O1_STRATEGY_TICK",
  "O1_STRATEGY_ERROR",
] as const;

const trailLogs: string[] = [];
let sawActivation = false;
let sawTrailEvaluation = false;
let sawSlRemove = false;
let sawSlSubmit = false;
let sawTrailUpdateRequest = false;

const captureLine = (line: string): void => {
  for (const tag of TRAIL_TAGS) {
    if (!line.includes(`[${tag}]`)) continue;
    trailLogs.push(line);
    if (line.includes("Trailing stop activated")) sawActivation = true;
    if (line.includes("Closed candle evaluated") && line.includes('"positionSize":')) {
      const m = line.match(/"positionSize":([0-9.]+)/);
      if (m && Number(m[1]) !== 0) sawTrailEvaluation = true;
    }
    if (line.includes("Trailing stop updated") || line.includes("Updating trailing stop-loss")) {
      sawTrailUpdateRequest = true;
    }
    if (line.includes("Removing trigger")) sawSlRemove = true;
    if (line.includes("Trigger submitted") && line.includes("[O1_SL]")) sawSlSubmit = true;
  }
};

const installLogCapture = (): (() => void) => {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const wrap =
    (fn: typeof console.log) =>
    (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      captureLine(line);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TriggerSnapshot = ReturnType<typeof summarizeTrigger>;

type O1ClientBundle = Awaited<ReturnType<typeof initO1Client>> & {
  state: ReturnType<typeof createInitialO1State>;
  summaries: TriggerSnapshot[];
  priceDecimals: number;
  sizeDecimals: number;
};

const fetchTriggersWithRetry = async (
  nord: O1ClientBundle["nord"],
  accountId: number,
  attempts = 3
): Promise<Awaited<ReturnType<typeof fetchActiveTriggers>>> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchActiveTriggers(nord, accountId);
    } catch (error) {
      lastError = error;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastError;
};

async function loadMarketSlSnapshot(useExistingClient = false): Promise<O1ClientBundle> {
  const { config, nord, user } = useExistingClient ? getInitializedO1Client() : await initO1Client();
  if (!config.accountId) throw new Error("Missing accountId");
  const state = createInitialO1State(config);
  syncO1StateFromUser(state, user, config.accountId, config.marketId);
  const info = await nord.getInfo();
  const market = info.markets.find((m) => m.marketId === config.marketId);
  const priceDecimals = market?.priceDecimals ?? 2;
  const sizeDecimals = market?.sizeDecimals ?? 4;
  const triggers = await fetchTriggersWithRetry(nord, config.accountId);
  const summaries = triggers
    .filter((t) => t.marketId === config.marketId && t.kind === "stopLoss")
    .map((t) => summarizeTrigger(t, priceDecimals, sizeDecimals));
  return { config, nord, user, state, summaries, priceDecimals, sizeDecimals };
}

async function preflight(): Promise<{
  positionSize: number;
  entryPrice: number;
  slTriggers: TriggerSnapshot[];
}> {
  const { state, summaries } = await loadMarketSlSnapshot();
  return {
    positionSize: state.positionSize,
    entryPrice: state.entryPrice,
    slTriggers: summaries,
  };
}

async function runPhase(trailingStartPct: number): Promise<{
  ok: boolean;
  reason?: string;
  initialSl?: number;
  finalSl?: number;
  triggerCount?: number;
}> {
  process.env.O1_MANAGE_EXISTING_POSITION_ONLY = "true";
  process.env.O1_TRAILING_START_PCT = String(trailingStartPct);
  process.env.O1_TRAILING_FORCE_ACTIVE = process.env.O1_TRAIL_VERIFY_FORCE_ACTIVE ?? "false";
  resetO1Client();

  const before = await preflight();
  const initialSl = before.slTriggers[0]?.triggerPrice;

  console.log("[O1_TRAIL_VERIFY] phase start", {
    trailingStartPct,
    positionSize: before.positionSize,
    entryPrice: before.entryPrice,
    initialSl,
    slCount: before.slTriggers.length,
    slTriggers: before.slTriggers,
  });

  if (before.positionSize <= 0) {
    return { ok: false, reason: "No open long position for trailing verification." };
  }
  if (before.slTriggers.length !== 1) {
    return { ok: false, reason: `Expected exactly 1 SL trigger, found ${before.slTriggers.length}.` };
  }

  const restoreLogs = installLogCapture();
  const manager = new O1BotManager();
  let botId = "";

  try {
    botId = await manager.start();
    const startedAt = Date.now();

    let lastTriggerCheckAt = 0;
    let lastTriggerCount = before.slTriggers.length;
    let lastOnChainSl = initialSl;

    while (Date.now() - startedAt < PHASE_MAX_MS) {
      await sleep(POLL_MS);

      const diagnostics = manager.getDiagnostics(botId);
      const now = Date.now();
      let currentSl = diagnostics.strategy.currentStopLoss ?? undefined;
      let triggerCount = lastTriggerCount;

      if (now - lastTriggerCheckAt >= 30_000 || sawSlSubmit) {
        try {
          const after = await loadMarketSlSnapshot(true);
          lastTriggerCheckAt = now;
          triggerCount = after.summaries.length;
          lastTriggerCount = triggerCount;
          currentSl = after.summaries[0]?.triggerPrice ?? currentSl;
          lastOnChainSl = currentSl;
        } catch (error) {
          console.warn("[O1_TRAIL_VERIFY] trigger fetch skipped", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const slMoved =
        initialSl !== undefined &&
        currentSl !== undefined &&
        triggerCount === 1 &&
        currentSl !== initialSl;
      const favorableMove =
        slMoved &&
        diagnostics.account.positionSize > 0 &&
        currentSl! > initialSl!;

      console.log("[O1_TRAIL_VERIFY] monitor", {
        elapsedMs: now - startedAt,
        trailingStartPct,
        positionSize: diagnostics.account.positionSize,
        trailingActive: diagnostics.strategy.trailingActive,
        currentStopLoss: diagnostics.strategy.currentStopLoss,
        lastSignal: diagnostics.strategy.lastSignal,
        lastSignalReason: diagnostics.strategy.lastSignalReason,
        triggerCount,
        currentSl: lastOnChainSl,
        initialSl,
        sawActivation,
        sawTrailUpdateRequest,
        sawSlRemove,
        sawSlSubmit,
      });

      if (favorableMove && sawSlRemove && sawSlSubmit) {
        await manager.stop(botId);
        restoreLogs();
        return {
          ok: true,
          initialSl,
          finalSl: currentSl,
          triggerCount,
        };
      }

      if (sawTrailUpdateRequest && sawSlRemove && !sawSlSubmit && now - startedAt > 60_000) {
        await manager.stop(botId);
        restoreLogs();
        return {
          ok: false,
          reason: "SL remove observed but new SL submit not confirmed.",
          initialSl,
          finalSl: lastOnChainSl,
          triggerCount: lastTriggerCount,
        };
      }
    }

    await manager.stop(botId);
    restoreLogs();

    if (sawActivation || sawTrailEvaluation) {
      return {
        ok: false,
        reason: "Trailing evaluated/activated but SL was not updated on-chain within phase timeout.",
        initialSl,
        finalSl: (await loadMarketSlSnapshot()).summaries[0]?.triggerPrice,
        triggerCount: (await loadMarketSlSnapshot()).summaries.length,
      };
    }

    return {
      ok: false,
      reason: "Trailing never activated within phase timeout.",
      initialSl,
      triggerCount: (await loadMarketSlSnapshot()).summaries.length,
    };
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

async function main(): Promise<void> {
  if (process.env.O1_DRY_RUN === "true") {
    throw new Error("O1_DRY_RUN must be false.");
  }
  if (process.env.O1_ALLOW_LIVE_TEST !== "true" || process.env.O1_TEST_MAINNET_CONFIRMED !== "true") {
    throw new Error("Set O1_ALLOW_LIVE_TEST=true and O1_TEST_MAINNET_CONFIRMED=true.");
  }

  console.log("[O1_TRAIL_VERIFY] preflight");
  const pre = await preflight();
  console.log("[O1_TRAIL_VERIFY] preflight result", pre);

  const config = readO1Env();
  process.env.O1_TRAIL_VERIFY_FORCE_ACTIVE = "true";
  let phase = await runPhase(config.strategyParams.trailingStartPct);
  if (!phase.ok && config.strategyParams.trailingStartPct > 0.05) {
    console.log("[O1_TRAIL_VERIFY] retrying with O1_TRAILING_START_PCT=0.05");
    sawActivation = false;
    sawTrailEvaluation = false;
    sawSlRemove = false;
    sawSlSubmit = false;
    sawTrailUpdateRequest = false;
    trailLogs.length = 0;
    phase = await runPhase(0.05);
  }

  resetO1Client();
  const final = await loadMarketSlSnapshot();
  const report = {
    success: phase.ok,
    reason: phase.reason,
    trailingStartPctUsed: phase.ok ? undefined : 0.05,
    initialSl: phase.initialSl,
    finalSl: phase.finalSl ?? final.summaries[0]?.triggerPrice,
    triggerCount: final.summaries.length,
    slTriggers: final.summaries,
    positionSize: final.state.positionSize,
    entryPrice: final.state.entryPrice,
    oldSlRemovedCorrectly: sawSlRemove,
    newSlSubmitted: sawSlSubmit,
    exactlyOneSl: final.summaries.length === 1,
    favorableDirection:
      phase.initialSl !== undefined &&
      phase.finalSl !== undefined &&
      final.state.positionSize > 0 &&
      phase.finalSl > phase.initialSl,
    sawActivation,
    sawTrailEvaluation,
    sawTrailUpdateRequest,
    trailLogs,
  };

  console.log("[O1_TRAIL_VERIFY] REPORT", JSON.stringify(report, null, 2));

  if (!phase.ok) {
    if (final.summaries.length > 1) {
      console.error("[O1_TRAIL_VERIFY] DUPLICATE TRIGGERS DETECTED — manual cleanup may be required", {
        triggers: final.summaries,
      });
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[O1_TRAIL_VERIFY] fatal", error);
  console.log("[O1_TRAIL_VERIFY] trail logs", trailLogs.slice(-50));
  process.exit(1);
});
