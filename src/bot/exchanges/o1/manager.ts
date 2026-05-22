import type { Nord, WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { Side } from "@n1xyz/nord-ts";
import { preloadO1Candles } from "./candlePreload";
import {
  logO1CandleMode,
  resolveO1CandleHandling,
  usesAggregatedCandles,
  type O1CandleHandling,
} from "./candleResolution";
import { detectClosed3mBucketMs, mergeLive1mIntoEffective3mCache } from "./candleAggregation";
import { detectDirectClosedCandleTs } from "./candleDirect";
import { pollRecentCandles } from "./candlePoll";
import { upsertCandle } from "./candleCache";
import { initO1Client, resetO1Client } from "./client";
import { readEmaCrossoverAtrLiveParams } from "./env";
import { sanitizeForApi } from "./logger";
import { O1Executor } from "./executor";
import {
  compactCandleDiagnostics,
  compactTriggerSpec,
  logDebug,
  logError,
  logInfo,
  logThrottle,
  logWarn,
  roundMetric,
} from "./logger";
import {
  logSyncFromFetch,
  logSyncStaleFallbackFailed,
  logSyncStaleFallbackIfNeeded,
  markAccountStreamHealthy,
} from "./syncLogger";
import { createInitialO1State } from "./state";
import { evaluateEmaAtrTrail3mStrategy } from "./strategies/emaAtrTrail3mStrategy";
import {
  buildEmaAtrTrail3mTickSnapshot,
  markStrategyReadyOnce,
} from "./strategies/emaAtrTrail3mDiagnostics";
import { evaluateEmaCrossoverAtrLiveStrategy } from "./strategies/emaCrossoverAtrLiveStrategy";
import {
  buildEmaCrossoverAtrLiveTickSnapshot,
  markEmaCrossoverAtrLiveReadyOnce,
} from "./strategies/emaCrossoverAtrLiveDiagnostics";
import {
  executeO1ClosePosition,
  executeO1CrossoverEntry,
  executeO1StopLossUpdate,
} from "./strategyExecution";
import {
  CONSERVATIVE_EMA_STRATEGY_NAME,
  EMA_ATR_TRAIL_3M_STRATEGY_NAME,
  EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME,
} from "./strategies/types";
import { getO1ConservativeEmaSignal } from "./strategyAdapter";
import { getO1HistoryDiagnostics, incrementRejection } from "./history";
import { scanHistoricalEmaCrossovers } from "./crossoverAnalysis";
import { recordCrossoverFromStrategySkip } from "./history/recordFromStrategy";
import { recordManagerCrossoverSkip } from "./history/recordEntryPath";
import type { O1Candle, O1Diagnostics, O1EmaCrossoverAtrLiveParams, O1EnvConfig, O1State } from "./types";
import {
  fetchActiveTriggers,
  filterMarketTriggersByKind,
  summarizeTrigger,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
  triggersMatchSpec,
} from "./liveTestSupport";
import { hydrateExistingPositionState, logManageOnlyMode } from "./positionHydration";
import { ensureProtectiveStopLoss, type StopGuardContext } from "./stopLossGuard";
import {
  applyExitCooldown,
  clearPositionLinkedStrategyState,
  hasStalePositionStrategyState,
  logStrategyStateUpdate,
  logStrategyTickFromState,
  seedStrategyDiagnosticsFromSnapshot,
} from "./strategyStateLifecycle";
import { createO1WsStreams, type O1WsHandle } from "./ws";
import type { O1TriggerSpec } from "./types";

export type O1StopResult = {
  stopped: boolean;
  botId: string;
  cleanupErrors: string[];
  remainingBots: string[];
};

type O1BotEntry = {
  id: string;
  state: O1State;
  nord: Nord;
  stop: () => Promise<O1StopResult>;
  executor: O1Executor;
  user: Awaited<ReturnType<typeof initO1Client>>["user"];
  pubkey: string;
  wsHandle?: O1WsHandle;
  reconnectTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  config: O1EnvConfig;
  priceDecimals: number;
  sizeDecimals: number;
  candleHandling: O1CandleHandling;
  oneMinuteCandles: O1Candle[];
  lastOneMinuteTs: number | null;
  lastLiveCandleTs: number | null;
  lastClosedTickTs: number | null;
  candlePayloadWatchdog?: NodeJS.Timeout;
  candlePollTimer?: NodeJS.Timeout;
  candleConnectedAt: number;
  lastPollIngestedTs: number | null;
  lastKnownPositionSize: number;
};

export class O1BotManager {
  private bots = new Map<string, O1BotEntry>();
  private stopGuardInFlight = new Set<string>();
  private stopGuardTimers = new Map<string, NodeJS.Timeout>();

  async start(): Promise<string> {
    if (this.bots.size > 0) throw new Error("An O1 bot is already running.");

    const { config, nord, user } = await initO1Client();
    if (!config.enabled) throw new Error("O1_ENABLED=false, refusing to start bot.");
    const botId = `o1-${config.symbol}-${config.resolution}`;
    if (this.bots.has(botId)) return botId;

    const state = createInitialO1State(config);
    const executor = new O1Executor(user, config, state);
    await executor.syncAccount();
    this.syncStateFromUser(state, user, config.marketId, config.accountId!);
    state.ws.lastAccountUpdateAt = Date.now();
    state.ws.lastAccountConnectAt = Date.now();

    const info = await nord.getInfo();
    const market = info.markets.find((entry) => entry.marketId === config.marketId || entry.symbol === config.symbol);
    const priceDecimals = market?.priceDecimals ?? 2;
    const sizeDecimals = market?.sizeDecimals ?? 4;
    state.strategy.activeStrategyName = config.strategyName;

    const candleHandling = resolveO1CandleHandling(config);
    logO1CandleMode(candleHandling);
    const usesAggregation = usesAggregatedCandles(candleHandling);
    const oneMinuteCandles: O1Candle[] = [];
    let lastOneMinuteTs: number | null = null;
    let lastLiveCandleTs: number | null = null;
    let lastClosedTickTs: number | null = null;
    let candleConnectedAt = 0;
    let candlePayloadWatchdog: NodeJS.Timeout | undefined;
    let candlePollTimer: NodeJS.Timeout | undefined;
    let lastPollIngestedTs: number | null = null;
    const live1mBufferMax = 12;

    const preloadedCandles = await preloadO1Candles(config);
    state.candles = [...preloadedCandles];
    state.candlePreloaded = preloadedCandles.length > 0;
    state.preloadedCandleCount = preloadedCandles.length;
    if (preloadedCandles.length > 0) {
      state.lastPrice = Number(preloadedCandles[preloadedCandles.length - 1][4]);
      const seededTs = Number(preloadedCandles[preloadedCandles.length - 1]![0]);
      if (!usesAggregation) {
        lastLiveCandleTs = seededTs;
        lastPollIngestedTs = seededTs;
      }
    }

    logInfo("O1_CANDLE_PRELOAD", "Effective candle cache ready", {
      candleMode: candleHandling.mode,
      effectiveResolution: candleHandling.effectiveResolution,
      preloadedCandleCount: state.preloadedCandleCount,
      effectiveCacheSize: state.candles.length,
    });

    if (state.candles.length > 0) {
      const lastPreloadedTs = Number(state.candles[state.candles.length - 1]![0]);
      if (config.strategyName === EMA_ATR_TRAIL_3M_STRATEGY_NAME) {
        const snapshot = buildEmaAtrTrail3mTickSnapshot(
          state,
          lastPreloadedTs,
          config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams
        );
        markStrategyReadyOnce(state, snapshot);
        seedStrategyDiagnosticsFromSnapshot(state, snapshot, lastPreloadedTs);
      } else if (config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME) {
        const snapshot = buildEmaCrossoverAtrLiveTickSnapshot(
          state,
          lastPreloadedTs,
          config.strategyParams as O1EmaCrossoverAtrLiveParams
        );
        markEmaCrossoverAtrLiveReadyOnce(state, snapshot);
        seedStrategyDiagnosticsFromSnapshot(state, snapshot, lastPreloadedTs);
      }
    }

    logManageOnlyMode(config.manageExistingPositionOnly);
    if (config.manageExistingPositionOnly && state.positionSize === 0) {
      throw new Error("O1_MANAGE_EXISTING_POSITION_ONLY=true but no open position exists.");
    }
    if (config.blockNewEntries || config.emergencyStop) {
      state.blockNewEntries = true;
      state.emergencyStop = state.emergencyStop || config.emergencyStop;
    }
    if (state.positionSize !== 0) {
      state.blockNewEntries = true;
      logWarn("O1_SAFE_MODE", "Open position detected at start — new entries blocked", {
        positionSize: state.positionSize,
      });
    }

    if (state.positionSize !== 0) {
      const hydrated = await hydrateExistingPositionState({
        state,
        nord,
        config,
        priceDecimals,
        sizeDecimals,
      });
      if (!hydrated.ok) {
        logWarn("O1_HYDRATE", "Could not hydrate SL from exchange — running stop guard", {
          reason: hydrated.reason,
          positionSize: state.positionSize,
        });
        const guardCtx = this.buildStopGuardContext(botId, nord, user, state, executor, config, priceDecimals, sizeDecimals);
        if (guardCtx) {
          await ensureProtectiveStopLoss(guardCtx, "startup-hydrate", { skipDebounce: true, force: true });
        }
      }
    }

    const reconnect = () => {
      const bot = this.bots.get(botId);
      if (!bot) return;
      const { reconnectCount } = bot.state.ws;
      if (reconnectCount >= config.reconnectAttemptsMax) {
        logError("O1_WS", "Reconnect attempts exceeded max limit", { reconnectCount });
        return;
      }
      bot.state.ws.reconnectCount += 1;
      bot.state.ws.lastReconnectAttemptAt = Date.now();
      const delay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** reconnectCount);
      logWarn("O1_WS", "Scheduling reconnect", { delay, reconnectCount });
      bot.reconnectTimer = setTimeout(() => {
        bot.wsHandle?.stop();
        bot.wsHandle?.start();
        void (async () => {
          await bot.executor.syncAccount();
          this.syncStateFromUser(bot.state, bot.user, bot.config.marketId, bot.config.accountId!);
          await this.reconcilePositionLifecycle(bot);
          await this.runStopLossGuard(botId, "ws-reconnect", { force: true });
        })();
      }, delay);
    };

    const scheduleCandlePayloadWatchdog = () => {
      if (candlePayloadWatchdog) clearTimeout(candlePayloadWatchdog);
      candleConnectedAt = Date.now();
      candlePayloadWatchdog = setTimeout(() => {
        if (!state.ws.candleConnected) return;
        if (state.ws.lastCandleUpdateAt >= candleConnectedAt) return;
        logWarn("O1_WS", "Candle stream connected but no candle payload received", {
          waitedMs: 90_000,
          symbol: config.symbol,
          streamResolution: candleHandling.streamResolution,
          effectiveResolution: candleHandling.effectiveResolution,
        });
      }, 90_000);
    };

    const handleLiveCandle = (candle: O1Candle, source: "ws" | "poll") => {
      if (usesAggregation) {
        const sourceTs = Number(candle[0]);
        const previousLatest1mTs = lastOneMinuteTs;
        upsertCandle(oneMinuteCandles, candle, live1mBufferMax);
        lastOneMinuteTs = sourceTs;

        const mergeResult = mergeLive1mIntoEffective3mCache(state.candles, oneMinuteCandles, config.maxCandleCache);
        state.lastPrice = Number(candle[4]);
        state.ws.lastCandleUpdateAt = Date.now();

        const closedCandleTs = detectClosed3mBucketMs(oneMinuteCandles, previousLatest1mTs, sourceTs);
        const diagnostics = compactCandleDiagnostics({
          source1mBufferSize: oneMinuteCandles.length,
          effective3mCandleCacheSize: state.candles.length,
          preloaded3mCandleCount: state.preloadedCandleCount,
          latestClosed3mCandleTs: closedCandleTs,
          latestLive3mBucketTs: mergeResult.latestLive3mBucketTs,
          formingBucketBarCount: mergeResult.formingBucketBarCount,
        });
        const cacheMismatch = state.candles.length < state.preloadedCandleCount;

        if (closedCandleTs !== null && closedCandleTs !== lastClosedTickTs) {
          lastClosedTickTs = closedCandleTs;
          logInfo("O1_CLOSED_3M_CANDLE", "Closed 3m aggregated candle detected", {
            ...diagnostics,
            effectiveResolution: candleHandling.effectiveResolution,
            source,
          });
          logInfo("O1_CLOSED_CANDLE", "Closed aggregated candle detected", {
            ...diagnostics,
            effectiveResolution: candleHandling.effectiveResolution,
            source,
          });
          void this.tick(botId, closedCandleTs);
        } else if (cacheMismatch) {
          logWarn("O1_CANDLE_LIVE_AGGREGATED", "Effective 3m cache below preloaded count", diagnostics);
        } else if (source === "ws") {
          logThrottle("O1_CANDLE_LIVE_AGGREGATED", 30_000, () => {
            logDebug("O1_CANDLE_LIVE_AGGREGATED", "Merged live 1m into effective 3m cache", diagnostics);
          });
        }
        return;
      }

      const ts = Number(candle[0]);
      const previousLatestTs = lastLiveCandleTs;
      upsertCandle(state.candles, candle, config.maxCandleCache);
      lastLiveCandleTs = ts;
      state.lastPrice = Number(candle[4]);
      state.ws.lastCandleUpdateAt = Date.now();
      logDebug("O1_CANDLE", "Direct candle cache updated", {
        ts,
        size: state.candles.length,
        price: state.lastPrice,
        source,
      });
      const closedCandleTs = detectDirectClosedCandleTs(previousLatestTs, ts);
      if (closedCandleTs !== null && closedCandleTs !== lastClosedTickTs) {
        lastClosedTickTs = closedCandleTs;
        logInfo("O1_CLOSED_DIRECT_CANDLE", "Closed direct candle detected", {
          closedCandleTs,
          currentCandleTs: ts,
          effectiveResolution: candleHandling.effectiveResolution,
          cacheSize: state.candles.length,
          source,
        });
        void this.tick(botId, closedCandleTs);
      }
    };

    const runCandlePoll = async () => {
      try {
        const pollCountback = usesAggregation ? 15 : 5;
        const result = await pollRecentCandles({
          config,
          streamResolution: String(candleHandling.streamResolution),
          countback: pollCountback,
          lastIngestedTs: lastPollIngestedTs,
          onCandle: (candle) => handleLiveCandle(candle, "poll"),
        });
        if (result.latestTs !== null) {
          lastPollIngestedTs = result.latestTs;
        }
      } catch (error) {
        logWarn("O1_CANDLE_POLL", "REST candle poll failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const wsHandle = createO1WsStreams({
      config,
      state,
      candleStreamResolution: candleHandling.streamResolution,
      onCandleConnected: scheduleCandlePayloadWatchdog,
      onCandle: (candle) => handleLiveCandle(candle, "ws"),
      onAccount: (payload) => {
        this.handleAccountUpdate(state, payload, config.marketId);
        void this.runStopLossGuard(botId, "account-ws");
      },
      onAccountConnected: () => {
        void (async () => {
          await executor.syncAccount();
          this.syncStateFromUser(state, user, config.marketId, config.accountId!);
          await this.runStopLossGuard(botId, "account-ws-connected", { force: true });
        })();
      },
      onTrade: (payload) => {
        this.handleTradeUpdate(state, payload);
      },
      onDisconnected: reconnect,
    });
    wsHandle.start();

    void runCandlePoll();
    candlePollTimer = setInterval(() => {
      void runCandlePoll();
    }, config.candlePollIntervalMs);
    logInfo("O1_CANDLE_POLL", "REST candle polling enabled", {
      intervalMs: config.candlePollIntervalMs,
      streamResolution: candleHandling.streamResolution,
      effectiveResolution: candleHandling.effectiveResolution,
    });

    const stopGuardWatchdog = setInterval(() => {
      void this.runStopLossGuard(botId, "watchdog");
    }, 20_000);

    const fallbackSyncIntervalMs = Math.max(30_000, config.wsStaleMs);
    const heartbeatTimer = setInterval(async () => {
      const botEntry = this.bots.get(botId);
      if (!botEntry) return;

      const now = Date.now();
      const accountAgeMs = state.ws.lastAccountUpdateAt > 0 ? now - state.ws.lastAccountUpdateAt : Number.POSITIVE_INFINITY;
      const wsStale = accountAgeMs > config.wsStaleMs;
      if (!wsStale) {
        markAccountStreamHealthy();
        return;
      }

      const sinceLastFallbackMs = now - state.ws.lastFallbackSyncAt;
      if (sinceLastFallbackMs < fallbackSyncIntervalMs) return;

      const staleCtx = {
        accountAgeMs,
        wsStaleMs: config.wsStaleMs,
        accountWsConnected: state.ws.accountConnected,
        accountWsHasPayload: state.accountWsHasPayload,
      };
      logSyncStaleFallbackIfNeeded(staleCtx);
      state.ws.lastFallbackSyncAt = now;
      const syncResult = await executor.syncAccount();
      if (syncResult.ok === false) {
        logSyncStaleFallbackFailed(staleCtx, syncResult.reason);
        return;
      }
      this.syncStateFromUser(state, user, config.marketId, config.accountId!);
      await this.reconcilePositionLifecycle(botEntry);
      await this.runStopLossGuard(botId, "heartbeat-fallback");
    }, Math.max(5000, Math.floor(config.wsStaleMs / 2)));

    const stop = async (): Promise<O1StopResult> => {
      const cleanupErrors: string[] = [];
      const runStep = async (label: string, fn: () => void | Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          cleanupErrors.push(`${label}: ${message}`);
          logWarn("O1_STOP", "Cleanup step failed", { label, message });
        }
      };

      await runStep("candlePayloadWatchdog", () => {
        if (candlePayloadWatchdog) clearTimeout(candlePayloadWatchdog);
      });
      await runStep("candlePollTimer", () => {
        if (candlePollTimer) clearInterval(candlePollTimer);
      });
      await runStep("stopGuardWatchdog", () => {
        const timer = this.stopGuardTimers.get(botId);
        if (timer) clearInterval(timer);
        this.stopGuardTimers.delete(botId);
      });
      await runStep("wsHandle", () => wsHandle.stop());
      const entry = this.bots.get(botId);
      await runStep("heartbeatTimer", () => {
        if (entry?.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      });
      await runStep("reconnectTimer", () => {
        if (entry?.reconnectTimer) clearTimeout(entry.reconnectTimer);
      });

      state.blockNewEntries = true;
      state.emergencyStop = true;
      this.bots.delete(botId);

      await runStep("resetO1Client", () => {
        resetO1Client();
      });

      logInfo("O1_STOP", "Stopped O1 bot", { botId, cleanupErrors });
      return {
        stopped: true,
        botId,
        cleanupErrors,
        remainingBots: Array.from(this.bots.keys()),
      };
    };

    this.stopGuardTimers.set(botId, stopGuardWatchdog);

    this.bots.set(botId, {
      id: botId,
      state,
      nord,
      stop,
      executor,
      user,
      pubkey: user.publicKey.toBase58(),
      wsHandle,
      heartbeatTimer,
      config,
      priceDecimals,
      sizeDecimals,
      candleHandling,
      oneMinuteCandles,
      lastOneMinuteTs,
      lastLiveCandleTs,
      lastClosedTickTs,
      candlePayloadWatchdog,
      candlePollTimer,
      candleConnectedAt,
      lastPollIngestedTs,
      lastKnownPositionSize: state.positionSize,
    });

    const bot = this.bots.get(botId);
    if (bot) {
      await this.reconcilePositionLifecycle(bot);
    }

    return botId;
  }

  private async tick(botId: string, closedCandleTs?: number): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;
    const { state, executor, config } = bot;
    if (state.emergencyStop) return;

    if (config.strategyName === EMA_ATR_TRAIL_3M_STRATEGY_NAME) {
      if (closedCandleTs === undefined) return;
      await this.runEmaAtrTrail3mStrategy(bot, closedCandleTs);
      return;
    }

    if (config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME) {
      if (closedCandleTs === undefined) return;
      await this.runEmaCrossoverAtrLiveStrategy(bot, closedCandleTs);
      return;
    }

    if (closedCandleTs !== undefined) return;
    if (state.lastSignalCandleTs === Number(state.candles[state.candles.length - 1]?.[0])) return;

    const signal = getO1ConservativeEmaSignal({
      state,
      riskPct: config.riskPct,
      maxPositionSize: config.maxPositionSize,
    });
    state.lastSignalCandleTs = Number(state.candles[state.candles.length - 1]?.[0] ?? 0);
    state.strategy.activeStrategyName = CONSERVATIVE_EMA_STRATEGY_NAME;
    state.strategy.lastSignal = signal.type;
    state.strategy.lastSignalReason = signal.type === "none" ? "no-conservative-ema-signal" : signal.type;

    if (signal.type === "openLong") await executor.openLong(signal.size);
    else if (signal.type === "openShort") await executor.openShort(signal.size);
    else if (signal.type === "closePosition") await executor.closePosition();
  }

  private async syncBotState(bot: O1BotEntry): Promise<void> {
    await bot.executor.syncAccount();
    this.syncStateFromUser(bot.state, bot.user, bot.config.marketId, bot.config.accountId!);
    await this.reconcilePositionLifecycle(bot);
  }

  private collectBotOwnedTriggerSpecs(bot: O1BotEntry): O1TriggerSpec[] {
    const specs: O1TriggerSpec[] = [];
    const active = bot.state.strategy.activeStopLossSpec;
    if (active) specs.push({ ...active });
    for (const recorded of bot.executor.getRecordedTriggerSpecs()) {
      if (!specs.some((spec) => this.triggerSpecEquals(spec, recorded))) {
        specs.push({ ...recorded });
      }
    }
    return specs;
  }

  private triggerSpecEquals(left: O1TriggerSpec, right: O1TriggerSpec): boolean {
    if (left.triggerId !== undefined && right.triggerId !== undefined) {
      return left.triggerId === right.triggerId;
    }
    return (
      left.marketId === right.marketId &&
      left.side === right.side &&
      left.kind === right.kind &&
      left.triggerPrice === right.triggerPrice &&
      (left.limitBaseSize ?? undefined) === (right.limitBaseSize ?? undefined)
    );
  }

  private async cleanupStaleBotTriggers(bot: O1BotEntry): Promise<void> {
    if (bot.state.positionSize !== 0) return;
    if (!bot.config.accountId) return;

    const ownedSpecs = this.collectBotOwnedTriggerSpecs(bot);
    if (ownedSpecs.length === 0) return;

    const triggers = await fetchActiveTriggers(bot.nord, bot.config.accountId);
    const marketTriggers = triggers.filter((t) => t.marketId === bot.config.marketId);

    for (const owned of ownedSpecs) {
      const match = marketTriggers.find((t) =>
        triggersMatchSpec(t, owned, bot.priceDecimals, bot.sizeDecimals)
      );
      if (!match) continue;
      const remove = await bot.executor.removeKnownTrigger(owned);
      logInfo("O1_STALE_TRIGGER_CLEANUP", "Removed bot-owned trigger while flat", {
        ok: remove.ok,
        reason: remove.ok === false ? remove.reason : undefined,
        trigger: owned,
      });
    }
  }

  private buildStopGuardContext(
    botId: string,
    nord: Nord,
    user: O1BotEntry["user"],
    state: O1State,
    executor: O1Executor,
    config: O1EnvConfig,
    priceDecimals: number,
    sizeDecimals: number
  ): StopGuardContext | null {
    if (!config.accountId) return null;
    return {
      state,
      config,
      nord,
      executor,
      priceDecimals,
      sizeDecimals,
      syncState: async () => {
        await executor.syncAccount();
        this.syncStateFromUser(state, user, config.marketId, config.accountId!);
      },
    };
  }

  private async runStopLossGuard(
    botId: string,
    source: string,
    options?: { force?: boolean }
  ): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot || bot.config.dryRun) return;
    if (bot.state.positionSize === 0 && !bot.state.strategy.pendingEntryProtection) return;
    if (this.stopGuardInFlight.has(botId)) return;

    const ctx = this.buildStopGuardContext(
      botId,
      bot.nord,
      bot.user,
      bot.state,
      bot.executor,
      bot.config,
      bot.priceDecimals,
      bot.sizeDecimals
    );
    if (!ctx) return;

    this.stopGuardInFlight.add(botId);
    bot.state.strategy.lastStopGuardSource = source;
    try {
      if (bot.state.positionSize === 0 && bot.state.strategy.pendingEntryProtection) {
        await ctx.syncState();
      }
      if (ctx.state.positionSize === 0) return;
      await ensureProtectiveStopLoss(ctx, source, {
        force: options?.force ?? bot.state.strategy.pendingEntryProtection,
        skipDebounce: options?.force ?? bot.state.strategy.pendingEntryProtection,
      });
    } finally {
      this.stopGuardInFlight.delete(botId);
    }
  }

  private async reconcilePositionLifecycle(bot: O1BotEntry): Promise<void> {
    const { state } = bot;
    const wasPosition = bot.lastKnownPositionSize;
    const isFlat = state.positionSize === 0;

    if (wasPosition === 0 && !isFlat) {
      logInfo("O1_POSITION_OPENED", "Position detected on account sync", {
        positionSize: state.positionSize,
        entryPrice: state.entryPrice,
      });
      await this.runStopLossGuard(bot.id, "position-opened", { force: true });
    } else if (!isFlat) {
      await this.runStopLossGuard(bot.id, "reconcile");
    }

    if (wasPosition !== 0 && isFlat) {
      clearPositionLinkedStrategyState(state);
      if (bot.config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME) {
        applyExitCooldown(state, (bot.config.strategyParams as O1EmaCrossoverAtrLiveParams).cooldownCandles);
      }
      logInfo("O1_POSITION_CLEARED", "Position closed; cleared strategy position state", {
        previousPositionSize: wasPosition,
        positionSize: state.positionSize,
      });
      await this.cleanupStaleBotTriggers(bot);
    } else if (isFlat && hasStalePositionStrategyState(state)) {
      clearPositionLinkedStrategyState(state);
      logInfo("O1_POSITION_CLEARED", "Flat account; cleared stale strategy position state", {
        positionSize: state.positionSize,
      });
      await this.cleanupStaleBotTriggers(bot);
    }

    bot.lastKnownPositionSize = state.positionSize;
  }

  private async runEmaAtrTrail3mStrategy(bot: O1BotEntry, closedCandleTs: number): Promise<void> {
    const { state, executor, config, candleHandling } = bot;

    await this.syncBotState(bot);

    const trailParams = config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams;
    const warmupSnapshot = buildEmaAtrTrail3mTickSnapshot(state, closedCandleTs, trailParams);
    markStrategyReadyOnce(state, warmupSnapshot);

    const action = evaluateEmaAtrTrail3mStrategy({
      state,
      closedCandleTs,
      marketId: config.marketId,
      maxPositionSize: config.maxPositionSize,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
      params: trailParams,
    });

    logStrategyStateUpdate(state, closedCandleTs);
    logStrategyTickFromState(state, candleHandling.effectiveResolution, closedCandleTs);

    if (action.type === "none") {
      if (action.crossover) {
        recordCrossoverFromStrategySkip(bot, closedCandleTs, action.crossover, action.reason);
      }
      logInfo("O1_STRATEGY_SKIP", "No strategy action for closed candle", {
        closedCandleTs,
        reason: action.reason,
      });
      return;
    }

    if (action.type === "openLong" || action.type === "openShort") {
      if (state.blockNewEntries || state.emergencyStop) {
        logWarn("O1_STRATEGY_SKIP", "Entry signal ignored — safe mode active", {
          signal: action.type,
        });
        return;
      }
      await executeO1CrossoverEntry(
        {
          state,
          config,
          nord: bot.nord,
          candleHandling,
          executor,
          priceDecimals: bot.priceDecimals,
          sizeDecimals: bot.sizeDecimals,
          syncState: () => this.syncBotState(bot),
        },
        closedCandleTs,
        action
      );
      return;
    }

    if (action.type === "updateTrailStop") {
      const currentSpec = state.strategy.activeStopLossSpec;
      if (!currentSpec) {
        logError("O1_STRATEGY_ERROR", "Trailing update requested without active stop-loss spec");
        return;
      }

      const nextSpec = {
        ...currentSpec,
        triggerPrice: action.stopLoss,
      };

      logInfo("O1_TRAIL", "Updating trailing stop-loss", {
        oldSL: action.previousStopLoss,
        newSL: action.stopLoss,
        dryRun: config.dryRun,
      });

      if (!config.dryRun) {
        const updateResult = await executor.updateStopLoss(currentSpec, nextSpec);
        if (updateResult.ok === false) {
          logError("O1_STRATEGY_ERROR", "Trailing stop-loss update failed", {
            reason: updateResult.reason,
          });
          return;
        }
      }

      state.strategy.activeStopLossSpec = nextSpec;
    }
  }

  private async runEmaCrossoverAtrLiveStrategy(bot: O1BotEntry, closedCandleTs: number): Promise<void> {
    const { state, executor, config, candleHandling } = bot;
    const params = config.strategyParams as O1EmaCrossoverAtrLiveParams;
    const execCtx = {
      state,
      config,
      candleHandling,
      executor,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
      syncState: () => this.syncBotState(bot),
    };

    await this.syncBotState(bot);

    const warmupSnapshot = buildEmaCrossoverAtrLiveTickSnapshot(state, closedCandleTs, params);
    markEmaCrossoverAtrLiveReadyOnce(state, warmupSnapshot);

    const action = evaluateEmaCrossoverAtrLiveStrategy({
      state,
      closedCandleTs,
      marketId: config.marketId,
      maxPositionSize: config.maxPositionSize,
      maxOrderNotional: config.maxOrderNotional,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
      params,
    });

    const crossoverSnapshot =
      action.type === "none" || action.type === "openLong" || action.type === "openShort"
        ? action.crossover
        : undefined;
    if (crossoverSnapshot?.strengthDetails) {
      const strengthDetails = crossoverSnapshot.strengthDetails;
      logInfo("O1_STRENGTH_CALC", "Crossover strength calculated", {
        direction: crossoverSnapshot.direction,
        currentClose: roundMetric(strengthDetails.currentClose),
        lookbackCount: strengthDetails.lookbackCloses.length,
        selectedReferenceClose: roundMetric(strengthDetails.selectedReferenceClose),
        selectedReferenceCandleTs: strengthDetails.selectedReferenceCandleTs,
        strengthPct: roundMetric(strengthDetails.strengthPct),
        formula: strengthDetails.formula,
      });
    }

    logStrategyStateUpdate(state, closedCandleTs);
    logStrategyTickFromState(state, candleHandling.effectiveResolution, closedCandleTs);

    if (action.type === "none") {
      if (action.reason === "no-ema-cross") {
        incrementRejection("noCross");
      } else if (action.crossover) {
        incrementRejection("crossFound");
        if (action.reason === "strength-below-threshold") incrementRejection("strengthRejected");
        if (action.reason === "cooldown-active") incrementRejection("cooldownRejected");
        if (action.reason === "invalid-position-size") incrementRejection("qtyZeroRejected");
        recordCrossoverFromStrategySkip(bot, closedCandleTs, action.crossover, action.reason);
      }
      if (action.reason !== "position-open-managing" && action.reason !== "no-ema-cross") {
        logInfo("O1_STRATEGY_SKIP", "No strategy action for closed candle", {
          closedCandleTs,
          reason: action.reason,
        });
      }
      return;
    }

    if (action.type === "openLong" || action.type === "openShort") {
      if (action.crossover) {
        incrementRejection("crossFound");
        recordManagerCrossoverSkip(
          { state, config, candleHandling },
          closedCandleTs,
          action.crossover,
          "signal_found",
          { signal: action.type }
        );
      }
      if (state.blockNewEntries || state.emergencyStop) {
        if (state.blockNewEntries) incrementRejection("blockNewEntriesRejected");
        if (state.emergencyStop) incrementRejection("emergencyStopRejected");
        logWarn("O1_STRATEGY_SKIP", "Entry signal ignored — safe mode active", {
          signal: action.type,
          blockNewEntries: state.blockNewEntries,
          emergencyStop: state.emergencyStop,
        });
        return;
      }
      await executeO1CrossoverEntry({ ...execCtx, nord: bot.nord }, closedCandleTs, action);
      return;
    }

    if (action.type === "updateStopLoss") {
      await executeO1StopLossUpdate(execCtx, action);
      return;
    }

    if (action.type === "closePosition") {
      await executeO1ClosePosition(execCtx, action.reason);
      await this.syncBotState(bot);
    }
  }

  private handleAccountUpdate(state: O1State, payload: WebSocketAccountUpdate, marketId: number): void {
    const now = Date.now();
    state.accountWsHasPayload = true;
    state.accountStateSource = "websocket";
    state.ws.lastAccountUpdateAt = now;
    state.ws.lastAccountPayloadAt = now;
    const orders = [...Object.entries(payload.places ?? {}), ...Object.entries(payload.reduced_orders ?? {})].map(([key, value]) => ({
      orderId: Number(key),
      marketId: Number(value.market_id),
      side: value.side,
      size: Number(value.current_size),
      price: Number(value.price),
      originalOrderSize: Number(value.current_size),
      clientOrderId: value.client_order_id ?? null,
    }));
    state.orders = orders.filter((o) => o.marketId === marketId);

    const balances = Object.values(payload.balances ?? {});
    const total = balances.reduce((sum, x) => sum + Number(x), 0);
    state.balanceTotal = total;
    state.balanceAvailable = total;
    logDebug("O1_ACCOUNT", "Account update processed", {
      orders: state.orders.length,
      balanceTotal: state.balanceTotal,
      updateId: payload.update_id,
    });
  }

  private handleTradeUpdate(state: O1State, payload: WebSocketTradeUpdate): void {
    const lastTrade = payload.trades[payload.trades.length - 1];
    if (!lastTrade) return;
    state.lastPrice = Number(lastTrade.price);
  }

  private syncStateFromUser(state: O1State, user: Awaited<ReturnType<typeof initO1Client>>["user"], marketId: number, accountId: number): void {
    const key = String(accountId);
    const positions = user.positions[key] ?? [];
    const target = positions.find((p) => p.marketId === marketId);
    const base = target?.perp?.baseSize ?? 0;
    const signed = target?.perp?.isLong ? base : -base;
    state.positionSize = Number.isFinite(signed) ? signed : 0;
    state.entryPrice = Number(target?.perp?.price ?? 0);
    state.orders = (user.orders[key] ?? []).filter((o) => o.marketId === marketId).map((o) => ({
      orderId: o.orderId,
      marketId: o.marketId,
      side: o.side,
      size: o.size,
      price: o.price,
      originalOrderSize: o.originalOrderSize,
      clientOrderId: o.clientOrderId,
    }));

    const balances = user.balances[key] ?? [];
    const total = balances.reduce((sum, item) => sum + Number(item.balance), 0);
    state.balanceTotal = total;
    state.balanceAvailable = total;
    if (!state.accountWsHasPayload) {
      state.accountStateSource = "fetchInfo";
    }
    state.lastSyncAt = Date.now();
    state.ws.lastAccountUpdateAt = Date.now();
    logSyncFromFetch(accountId, state);
  }

  async stop(botId: string): Promise<O1StopResult> {
    const bot = this.bots.get(botId);
    if (!bot) {
      return {
        stopped: false,
        botId,
        cleanupErrors: [`O1 bot ${botId} not found.`],
        remainingBots: Array.from(this.bots.keys()),
      };
    }
    return bot.stop();
  }

  async safeStop(botId?: string): Promise<O1StopResult> {
    if (!botId) {
      const ids = Array.from(this.bots.keys());
      if (ids.length === 0) {
        return { stopped: true, botId: "", cleanupErrors: [], remainingBots: [] };
      }
      const results: O1StopResult[] = [];
      for (const id of ids) {
        results.push(await this.safeStop(id));
      }
      return {
        stopped: results.every((r) => r.stopped),
        botId: ids.join(","),
        cleanupErrors: results.flatMap((r) => r.cleanupErrors),
        remainingBots: Array.from(this.bots.keys()),
      };
    }
    try {
      return await this.stop(botId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.bots.delete(botId);
      return {
        stopped: false,
        botId,
        cleanupErrors: [message],
        remainingBots: Array.from(this.bots.keys()),
      };
    }
  }

  async getBots(): Promise<string[]> {
    return Array.from(this.bots.keys());
  }

  async forceSync(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`O1 bot ${botId} not found.`);
    await this.syncBotState(bot);
  }

  setEmergencyStop(botId: string, enabled: boolean): void {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`O1 bot ${botId} not found.`);
    bot.state.emergencyStop = enabled;
    if (enabled) bot.state.blockNewEntries = true;
  }

  setBlockNewEntries(botId: string, enabled: boolean): void {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`O1 bot ${botId} not found.`);
    bot.state.blockNewEntries = enabled;
    if (enabled) bot.state.emergencyStop = true;
  }

  private buildCrossoverAnalysis(bot: O1BotEntry): O1Diagnostics["crossoverAnalysis"] {
    if (bot.config.strategyName !== EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME) return undefined;
    const params = bot.config.strategyParams as O1EmaCrossoverAtrLiveParams;
    const scan = scanHistoricalEmaCrossovers(bot.state.candles, params);
    return {
      strategyName: bot.config.strategyName,
      symbol: bot.config.symbol,
      resolution: String(bot.config.resolution),
      candleMode: bot.candleHandling.mode,
      emaShortPeriod: scan.emaShortPeriod,
      emaLongPeriod: scan.emaLongPeriod,
      atrPeriod: scan.atrPeriod,
      strengthLookbackCandles: scan.strengthLookbackCandles,
      candlesLoaded: scan.candlesLoaded,
      firstCandleTs: scan.firstCandleTs,
      lastCandleTs: scan.lastCandleTs,
      scannedCandleCount: scan.scannedCandleCount,
      warmupSkippedCount: scan.warmupSkippedCount,
      totalCrosses: scan.totalCrosses,
      longCrosses: scan.longCrosses,
      shortCrosses: scan.shortCrosses,
      last20CrossoverCandidates: scan.events.slice(-20),
    };
  }

  getDiagnostics(botId: string): O1Diagnostics {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`O1 bot ${botId} not found.`);
    const state = bot.state;
    const { config, candleHandling } = bot;
    const accountAgeMs = state.ws.lastAccountUpdateAt > 0
      ? Date.now() - state.ws.lastAccountUpdateAt
      : null;
    return {
      env: {
        enabled: config.enabled,
        dryRun: config.dryRun,
        emergencyStop: state.emergencyStop,
        solanaRpcUrl: config.solanaRpcUrl,
        webServerUrl: config.webServerUrl,
        wsUrl: config.wsUrl,
        marketId: config.marketId,
        symbol: config.symbol,
        resolution: config.resolution,
        accountId: config.accountId,
        riskPct: config.riskPct,
        defaultLeverage: config.defaultLeverage,
        strategyName: config.strategyName,
        emaShortPeriod:
          config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME
            ? (config.strategyParams as O1EmaCrossoverAtrLiveParams).emaShortPeriod
            : (config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams).emaShortPeriod,
        emaLongPeriod:
          config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME
            ? (config.strategyParams as O1EmaCrossoverAtrLiveParams).emaLongPeriod
            : (config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams).emaLongPeriod,
      },
      initialized: { nord: true, user: true },
      user: { pubkey: bot.pubkey, accountId: config.accountId },
      account: {
        balanceTotal: state.balanceTotal,
        balanceAvailable: state.balanceAvailable,
        positionSize: state.positionSize,
        entryPrice: state.entryPrice,
        openOrders: state.orders.length,
      },
      market: {
        lastPrice: state.lastPrice,
        lastCandleTs: Number(state.candles[state.candles.length - 1]?.[0] ?? 0),
        candleCacheSize: state.candles.length,
        candlePreloaded: state.candlePreloaded,
        preloadedCandleCount: state.preloadedCandleCount,
      },
      candles: {
        configuredResolution: candleHandling.configuredResolution,
        effectiveResolution: candleHandling.effectiveResolution,
        candleMode: candleHandling.mode,
        streamResolution: String(candleHandling.streamResolution),
      },
      strategyParams: config.strategyParams,
      ws: {
        ...state.ws,
        accountAgeMs,
        accountWsConnected: state.ws.accountConnected,
        accountWsHasPayload: state.accountWsHasPayload,
        accountStateSource: state.accountStateSource,
      },
      safety: {
        emergencyStop: state.emergencyStop,
        blockNewEntries: state.blockNewEntries,
        dryRun: config.dryRun,
        pendingOrders: state.pendingClientOrderIds.size,
        cooldownMs: config.cooldownMs,
        pendingEntryProtection: state.strategy.pendingEntryProtection,
        lastStopGuardAt: state.lastStopGuardAt,
        lastStopGuardSource: state.strategy.lastStopGuardSource,
      },
      strategy: state.strategy,
      history: getO1HistoryDiagnostics(),
      crossoverAnalysis: this.buildCrossoverAnalysis(bot),
      poll: {
        intervalMs: config.candlePollIntervalMs,
        lastPollIngestedTs: bot.lastPollIngestedTs,
        enabled: config.candlePollIntervalMs > 0,
      },
    };
  }

  private async fetchExchangeDiagnostics(botId: string): Promise<Record<string, unknown>> {
    const { config, nord, user } = await initO1Client();
    const expectedBotId = `o1-${config.symbol}-${config.resolution}`;
    await user.fetchInfo();
    const info = await nord.getInfo();
    const market = info.markets.find(
      (entry) => entry.marketId === config.marketId || entry.symbol === config.symbol
    );
    const priceDecimals = market?.priceDecimals ?? 2;
    const sizeDecimals = market?.sizeDecimals ?? 4;
    const snapshot = createInitialO1State(config);
    syncO1StateFromUser(snapshot, user, config.accountId!, config.marketId);
    const triggers = config.accountId
      ? await fetchActiveTriggers(nord, config.accountId)
      : [];
    const marketTriggers = triggers.filter((row) => row.marketId === config.marketId);
    const slTriggers = filterMarketTriggersByKind(triggers, config.marketId, "stopLoss");
    const slSummaries = slTriggers.map((row) => summarizeTrigger(row, priceDecimals, sizeDecimals));
    const newestSl = slTriggers.length
      ? slTriggers.reduce((latest, row) =>
          Number(row.triggerId) > Number(latest.triggerId) ? row : latest
        )
      : null;
    const activeStopLossSpec = newestSl
      ? sanitizeForApi(toTriggerSpecFromApi(newestSl, priceDecimals, sizeDecimals))
      : null;

    const botResolutionSuffix = botId.split("-").pop();
    const shouldRunCrossoverScan =
      config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME ||
      (botId.startsWith(`o1-${config.symbol}-`) && botResolutionSuffix === "1");

    const scanConfig = { ...config };
    if (shouldRunCrossoverScan) {
      scanConfig.strategyName = EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME;
      scanConfig.strategyParams = readEmaCrossoverAtrLiveParams();
      if (botResolutionSuffix && /^\d+$/.test(botResolutionSuffix)) {
        scanConfig.resolution = botResolutionSuffix as import("./types").O1EnvConfig["resolution"];
      }
    }

    const preloaded = shouldRunCrossoverScan ? await preloadO1Candles(scanConfig) : [];

    let crossoverAnalysis: O1Diagnostics["crossoverAnalysis"];
    if (shouldRunCrossoverScan) {
      const params = scanConfig.strategyParams as O1EmaCrossoverAtrLiveParams;
      const scan = scanHistoricalEmaCrossovers(preloaded, params);
      crossoverAnalysis = {
        strategyName: scanConfig.strategyName,
        symbol: scanConfig.symbol,
        resolution: String(scanConfig.resolution),
        candleMode: resolveO1CandleHandling(scanConfig).mode,
        emaShortPeriod: scan.emaShortPeriod,
        emaLongPeriod: scan.emaLongPeriod,
        atrPeriod: scan.atrPeriod,
        strengthLookbackCandles: scan.strengthLookbackCandles,
        candlesLoaded: scan.candlesLoaded,
        firstCandleTs: scan.firstCandleTs,
        lastCandleTs: scan.lastCandleTs,
        scannedCandleCount: scan.scannedCandleCount,
        warmupSkippedCount: scan.warmupSkippedCount,
        totalCrosses: scan.totalCrosses,
        longCrosses: scan.longCrosses,
        shortCrosses: scan.shortCrosses,
        last20CrossoverCandidates: scan.events.slice(-20),
      };
    }

    return {
      botRunning: false,
      botId,
      expectedBotId,
      botIdMatchesEnv: botId === expectedBotId,
      crossoverAnalysis,
      account: {
        accountId: config.accountId,
        balanceTotal: snapshot.balanceTotal,
        balanceAvailable: snapshot.balanceAvailable,
        positionSize: snapshot.positionSize,
        entryPrice: snapshot.entryPrice,
        openOrders: snapshot.orders.length,
      },
      exchange: {
        activeTriggers: marketTriggers.length,
        slCount: slTriggers.length,
        triggerIds: marketTriggers.map((row) => String(row.triggerId)),
        slTriggerIds: slTriggers.map((row) => String(row.triggerId)),
        triggerSummaries: slSummaries,
        activeStopLossSpec,
        currentStopLoss: activeStopLossSpec
          ? (activeStopLossSpec as { triggerPrice?: number }).triggerPrice ?? null
          : null,
      },
      safety: {
        emergencyStop: config.emergencyStop,
        blockNewEntries: config.blockNewEntries,
        dryRun: config.dryRun,
      },
      history: getO1HistoryDiagnostics(),
      strategyParams: config.strategyParams,
      env: {
        enabled: config.enabled,
        dryRun: config.dryRun,
        emergencyStop: config.emergencyStop,
        symbol: config.symbol,
        resolution: config.resolution,
        marketId: config.marketId,
        accountId: config.accountId,
        strategyName: config.strategyName,
        riskPct: config.riskPct,
        defaultLeverage: config.defaultLeverage,
        emaShortPeriod:
          config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME
            ? (config.strategyParams as O1EmaCrossoverAtrLiveParams).emaShortPeriod
            : (config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams).emaShortPeriod,
        emaLongPeriod:
          config.strategyName === EMA_CROSSOVER_ATR_LIVE_STRATEGY_NAME
            ? (config.strategyParams as O1EmaCrossoverAtrLiveParams).emaLongPeriod
            : (config.strategyParams as import("./types").O1EmaAtrTrailStrategyParams).emaLongPeriod,
      },
      candles: {
        configuredResolution: String(config.resolution),
        effectiveResolution: String(config.resolution),
        candleMode: resolveO1CandleHandling(config).mode,
        streamResolution: String(config.resolution),
      },
      market: {
        candleCacheSize: preloaded.length,
        preloadedCandleCount: preloaded.length,
        candlePreloaded: preloaded.length > 0,
      },
    };
  }

  async getSafeDiagnostics(
    botId: string
  ): Promise<{ diagnostics: O1Diagnostics | Record<string, unknown>; diagnosticsError?: string }> {
    const bot = this.bots.get(botId);
    if (!bot) {
      try {
        const exchange = await this.fetchExchangeDiagnostics(botId);
        return {
          diagnostics: sanitizeForApi(exchange) as O1Diagnostics,
          diagnosticsError: `O1 bot ${botId} is not running; exchange snapshot only.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          diagnostics: { botId, botRunning: false },
          diagnosticsError: message,
        };
      }
    }

    try {
      const diagnostics = this.getDiagnostics(botId);
      const triggers = bot.config.accountId
        ? await fetchActiveTriggers(bot.nord, bot.config.accountId)
        : [];
      const slTriggers = filterMarketTriggersByKind(triggers, bot.config.marketId, "stopLoss");
      const slSummaries = slTriggers.map((row) =>
        summarizeTrigger(row, bot.priceDecimals, bot.sizeDecimals)
      );
      const enriched = {
        ...diagnostics,
        exchange: {
          activeTriggers: triggers.filter((row) => row.marketId === bot.config.marketId).length,
          slCount: slTriggers.length,
          triggerIds: triggers
            .filter((row) => row.marketId === bot.config.marketId)
            .map((row) => String(row.triggerId)),
          slTriggerIds: slTriggers.map((row) => String(row.triggerId)),
          triggerSummaries: slSummaries,
        },
      };
      return { diagnostics: sanitizeForApi(enriched) as O1Diagnostics };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const partial = {
        botId,
        botRunning: true,
        error: message,
        account: {
          positionSize: bot.state.positionSize,
          entryPrice: bot.state.entryPrice,
          openOrders: bot.state.orders.length,
        },
        strategy: sanitizeForApi(bot.state.strategy),
        safety: {
          emergencyStop: bot.state.emergencyStop,
          blockNewEntries: bot.state.blockNewEntries,
        },
      };
      return {
        diagnostics: partial as unknown as O1Diagnostics,
        diagnosticsError: message,
      };
    }
  }
}
