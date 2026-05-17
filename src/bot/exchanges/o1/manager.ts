import type { WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
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
import { getInitializedO1Client, initO1Client, resetO1Client } from "./client";
import { O1Executor } from "./executor";
import {
  compactCandleDiagnostics,
  compactTriggerSpec,
  logDebug,
  logError,
  logInfo,
  logThrottle,
  logWarn,
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
import { CONSERVATIVE_EMA_STRATEGY_NAME, EMA_ATR_TRAIL_3M_STRATEGY_NAME } from "./strategies/types";
import { getO1ConservativeEmaSignal } from "./strategyAdapter";
import { getO1HistoryDiagnostics } from "./history";
import { recordCrossoverFromStrategySkip } from "./history/recordFromStrategy";
import {
  mapExecutorReasonToCrossoverReason,
  recordManagerCrossoverSkip,
  recordManagerEntryEvent,
} from "./history/recordEntryPath";
import type { O1Candle, O1Diagnostics, O1EnvConfig, O1State } from "./types";
import { fetchActiveTriggers, triggersMatchSpec } from "./liveTestSupport";
import { hydrateExistingPositionState, logManageOnlyMode } from "./positionHydration";
import {
  clearPositionLinkedStrategyState,
  hasStalePositionStrategyState,
  logStrategyStateUpdate,
  logStrategyTickFromState,
  seedStrategyDiagnosticsFromSnapshot,
} from "./strategyStateLifecycle";
import { createO1WsStreams, type O1WsHandle } from "./ws";
import type { O1TriggerSpec } from "./types";

type O1BotEntry = {
  id: string;
  state: O1State;
  stop: () => Promise<void>;
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

const clampEntrySizeToLimits = (
  size: number,
  entryPrice: number,
  maxOrderNotional: number,
  maxPositionSize: number,
  sizeDecimals: number
): number => {
  if (!Number.isFinite(size) || size <= 0 || entryPrice <= 0) return 0;
  const maxByNotional = maxOrderNotional / entryPrice;
  const raw = Math.min(size, maxByNotional, maxPositionSize);
  const factor = 10 ** sizeDecimals;
  return Math.floor(raw * factor) / factor;
};

export class O1BotManager {
  private bots = new Map<string, O1BotEntry>();

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

    if (config.strategyName === EMA_ATR_TRAIL_3M_STRATEGY_NAME && state.candles.length > 0) {
      const lastPreloadedTs = Number(state.candles[state.candles.length - 1]![0]);
      const snapshot = buildEmaAtrTrail3mTickSnapshot(state, lastPreloadedTs, config.strategyParams);
      markStrategyReadyOnce(state, snapshot);
      seedStrategyDiagnosticsFromSnapshot(state, snapshot, lastPreloadedTs);
    }

    logManageOnlyMode(config.manageExistingPositionOnly);
    if (config.manageExistingPositionOnly && state.positionSize === 0) {
      throw new Error("O1_MANAGE_EXISTING_POSITION_ONLY=true but no open position exists.");
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
        throw new Error(`Failed to hydrate existing position: ${hydrated.reason}`);
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
    }, Math.max(5000, Math.floor(config.wsStaleMs / 2)));

    const stop = async () => {
      if (candlePayloadWatchdog) clearTimeout(candlePayloadWatchdog);
      if (candlePollTimer) clearInterval(candlePollTimer);
      wsHandle.stop();
      if (this.bots.get(botId)?.heartbeatTimer) clearInterval(this.bots.get(botId)!.heartbeatTimer);
      if (this.bots.get(botId)?.reconnectTimer) clearTimeout(this.bots.get(botId)!.reconnectTimer);
      this.bots.delete(botId);
      resetO1Client();
      logInfo("O1_STOP", "Stopped O1 bot");
    };

    this.bots.set(botId, {
      id: botId,
      state,
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

    const { nord } = getInitializedO1Client();
    const triggers = await fetchActiveTriggers(nord, bot.config.accountId);
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

  private async reconcilePositionLifecycle(bot: O1BotEntry): Promise<void> {
    const { state } = bot;
    const wasPosition = bot.lastKnownPositionSize;
    const isFlat = state.positionSize === 0;

    if (wasPosition !== 0 && isFlat) {
      clearPositionLinkedStrategyState(state);
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

    const warmupSnapshot = buildEmaAtrTrail3mTickSnapshot(state, closedCandleTs, config.strategyParams);
    markStrategyReadyOnce(state, warmupSnapshot);

    const action = evaluateEmaAtrTrail3mStrategy({
      state,
      closedCandleTs,
      marketId: config.marketId,
      maxPositionSize: config.maxPositionSize,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
      params: config.strategyParams,
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
      const direction = action.type === "openLong" ? "long" : "short";
      const snapshot = action.crossover;
      const historyCtx = { state, config, candleHandling };

      if (config.manageExistingPositionOnly) {
        recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-other", {
          block: "manage-existing-position-only",
        });
        logError("O1_STRATEGY_ERROR", "Entry blocked in manage-existing-position-only mode", {
          side: action.type,
          closedCandleTs,
        });
        return;
      }
      if (state.positionSize !== 0) {
        recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-existing-position", {
          positionSize: state.positionSize,
        });
        logDebug("O1_STRATEGY_SKIP", "Open blocked because a position is already open", {
          positionSize: state.positionSize,
          closedCandleTs,
        });
        return;
      }

      const entrySize = clampEntrySizeToLimits(
        action.size,
        action.entryPrice,
        config.maxOrderNotional,
        config.maxPositionSize,
        bot.sizeDecimals
      );
      if (entrySize <= 0) {
        recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-invalid-size", {
          requestedSize: action.size,
          entryPrice: action.entryPrice,
          maxOrderNotional: config.maxOrderNotional,
        });
        logError("O1_STRATEGY_ERROR", "Entry size clamped to zero", {
          requestedSize: action.size,
          entryPrice: action.entryPrice,
          maxOrderNotional: config.maxOrderNotional,
        });
        return;
      }
      logInfo("O1_ENTRY", "Executing entry", {
        side: direction,
        size: entrySize,
        requestedSize: action.size,
        entryPrice: action.entryPrice,
        stopLoss: action.stopLoss,
        dryRun: config.dryRun,
      });

      if (config.dryRun) {
        const crossoverRecord = recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-dry-run", {
          entrySize,
        });
        recordManagerEntryEvent(historyCtx, closedCandleTs, {
          crossoverId: crossoverRecord?.id ?? null,
          direction,
          entryPrice: action.entryPrice,
          size: entrySize,
          stopLoss: action.stopLoss,
          status: "attempted",
          orderResult: "dry-run",
        });
      }

      const openResult = action.type === "openLong"
        ? await executor.openLong(entrySize)
        : await executor.openShort(entrySize);
      if (openResult.ok === false) {
        const crossoverRecord = recordManagerCrossoverSkip(
          historyCtx,
          closedCandleTs,
          snapshot,
          mapExecutorReasonToCrossoverReason(openResult.reason),
          { executorReason: openResult.reason }
        );
        recordManagerEntryEvent(historyCtx, closedCandleTs, {
          crossoverId: crossoverRecord?.id ?? null,
          direction,
          entryPrice: action.entryPrice,
          size: entrySize,
          stopLoss: action.stopLoss,
          status: "failed",
          failureReason: openResult.reason,
        });
        logError("O1_STRATEGY_ERROR", "Entry order failed", {
          side: action.type,
          reason: openResult.reason,
        });
        return;
      }

      const orderData = openResult.data as { actionId?: string; orderId?: string } | undefined;
      const orderResult = orderData?.actionId ?? orderData?.orderId ?? "ok";

      await this.syncBotState(bot);
      if (state.positionSize === 0) {
        if (!config.dryRun) {
          const crossoverRecord = recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "skipped-executor-error", {
            note: "entry-ok-position-flat",
          });
          recordManagerEntryEvent(historyCtx, closedCandleTs, {
            crossoverId: crossoverRecord?.id ?? null,
            direction,
            entryPrice: action.entryPrice,
            size: entrySize,
            stopLoss: action.stopLoss,
            status: "failed",
            failureReason: "position-still-flat-after-entry",
            orderResult: String(orderResult),
          });
        }
        logError("O1_STRATEGY_ERROR", "Entry reported success but position is still flat", {
          side: action.type,
          size: action.size,
        });
        return;
      }

      const crossoverRecord = config.dryRun
        ? null
        : recordManagerCrossoverSkip(historyCtx, closedCandleTs, snapshot, "entered", { entrySize });

      const stopSide = action.type === "openLong" ? Side.Ask : Side.Bid;
      const stopSpec = state.strategy.activeStopLossSpec;
      if (!stopSpec) {
        recordManagerEntryEvent(historyCtx, closedCandleTs, {
          crossoverId: crossoverRecord?.id ?? null,
          direction,
          entryPrice: action.entryPrice,
          size: entrySize,
          stopLoss: action.stopLoss,
          status: "failed",
          failureReason: "missing-stop-loss-spec",
          orderResult: String(orderResult),
        });
        logError("O1_STRATEGY_ERROR", "Missing stop-loss spec after entry", { side: action.type });
        await executor.closePosition();
        return;
      }

      const stopSize = Math.abs(state.positionSize) > 0 ? Math.abs(state.positionSize) : entrySize;
      const stopSpecForPosition = { ...stopSpec, limitBaseSize: stopSize };
      logInfo("O1_SL", "Placing initial stop-loss", compactTriggerSpec(stopSpecForPosition));
      if (!config.dryRun) {
        const stopResult = await executor.placeStopLoss(stopSpec.triggerPrice, stopSide, stopSize);
        if (stopResult.ok === false) {
          recordManagerEntryEvent(historyCtx, closedCandleTs, {
            crossoverId: crossoverRecord?.id ?? null,
            direction,
            entryPrice: action.entryPrice,
            size: entrySize,
            stopLoss: action.stopLoss,
            status: "closed-by-safety",
            failureReason: stopResult.reason,
            orderResult: String(orderResult),
            slTriggerResult: stopResult.reason,
          });
          logError("O1_STRATEGY_ERROR", "Initial stop-loss placement failed; closing position", {
            reason: stopResult.reason,
          });
          await this.syncBotState(bot);
          await executor.closePosition();
          return;
        }
        recordManagerEntryEvent(historyCtx, closedCandleTs, {
          crossoverId: crossoverRecord?.id ?? null,
          direction,
          entryPrice: action.entryPrice,
          size: entrySize,
          stopLoss: action.stopLoss,
          status: "opened",
          orderResult: String(orderResult),
          slTriggerResult: "placed",
        });
      }

      state.trailingActive = false;
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

  async stop(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`O1 bot ${botId} not found.`);
    await bot.stop();
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
        dryRun: config.dryRun,
        pendingOrders: state.pendingClientOrderIds.size,
        cooldownMs: config.cooldownMs,
      },
      strategy: state.strategy,
      history: getO1HistoryDiagnostics(),
    };
  }
}
