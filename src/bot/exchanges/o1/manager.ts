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
import { upsertCandle } from "./candleCache";
import { initO1Client, resetO1Client } from "./client";
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
  logEmaAtrTrail3mTick,
  markStrategyReadyOnce,
} from "./strategies/emaAtrTrail3mDiagnostics";
import { CONSERVATIVE_EMA_STRATEGY_NAME, EMA_ATR_TRAIL_3M_STRATEGY_NAME } from "./strategies/types";
import { getO1ConservativeEmaSignal } from "./strategyAdapter";
import type { O1Candle, O1Diagnostics, O1EnvConfig, O1State } from "./types";
import { createO1WsStreams, type O1WsHandle } from "./ws";

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
  candleConnectedAt: number;
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
    const live1mBufferMax = 12;

    const preloadedCandles = await preloadO1Candles(config);
    state.candles = [...preloadedCandles];
    state.candlePreloaded = preloadedCandles.length > 0;
    state.preloadedCandleCount = preloadedCandles.length;
    if (preloadedCandles.length > 0) {
      state.lastPrice = Number(preloadedCandles[preloadedCandles.length - 1][4]);
      if (!usesAggregation) {
        lastLiveCandleTs = Number(preloadedCandles[preloadedCandles.length - 1]![0]);
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

    const wsHandle = createO1WsStreams({
      config,
      state,
      candleStreamResolution: candleHandling.streamResolution,
      onCandleConnected: scheduleCandlePayloadWatchdog,
      onCandle: (candle) => {
        if (usesAggregation) {
          const sourceTs = Number(candle[0]);
          const previousLatest1mTs = lastOneMinuteTs;
          upsertCandle(oneMinuteCandles, candle, live1mBufferMax);
          lastOneMinuteTs = sourceTs;

          const mergeResult = mergeLive1mIntoEffective3mCache(state.candles, oneMinuteCandles, config.maxCandleCache);
          state.lastPrice = Number(candle[4]);

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
            logInfo("O1_CLOSED_CANDLE", "Closed aggregated candle detected", {
              ...diagnostics,
              effectiveResolution: candleHandling.effectiveResolution,
            });
            void this.tick(botId, closedCandleTs);
          } else if (cacheMismatch) {
            logWarn("O1_CANDLE_LIVE_AGGREGATED", "Effective 3m cache below preloaded count", diagnostics);
          } else {
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
        logDebug("O1_CANDLE", "Direct candle cache updated", {
          ts,
          size: state.candles.length,
          price: state.lastPrice,
        });
        const closedCandleTs = detectDirectClosedCandleTs(previousLatestTs, ts);
        if (closedCandleTs !== null && closedCandleTs !== lastClosedTickTs) {
          lastClosedTickTs = closedCandleTs;
          logInfo("O1_CLOSED_DIRECT_CANDLE", "Closed direct candle detected", {
            closedCandleTs,
            currentCandleTs: ts,
            effectiveResolution: candleHandling.effectiveResolution,
            cacheSize: state.candles.length,
          });
          void this.tick(botId, closedCandleTs);
        }
      },
      onAccount: (payload) => {
        this.handleAccountUpdate(state, payload, config.marketId);
      },
      onTrade: (payload) => {
        this.handleTradeUpdate(state, payload);
      },
      onDisconnected: reconnect,
    });
    wsHandle.start();

    const fallbackSyncIntervalMs = Math.max(30_000, config.wsStaleMs);
    const heartbeatTimer = setInterval(async () => {
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
    }, Math.max(5000, Math.floor(config.wsStaleMs / 2)));

    const stop = async () => {
      if (candlePayloadWatchdog) clearTimeout(candlePayloadWatchdog);
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
      candleConnectedAt,
    });

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
  }

  private async runEmaAtrTrail3mStrategy(bot: O1BotEntry, closedCandleTs: number): Promise<void> {
    const { state, executor, config, candleHandling } = bot;
    const tickSnapshot = buildEmaAtrTrail3mTickSnapshot(state, closedCandleTs, config.strategyParams);
    logEmaAtrTrail3mTick(tickSnapshot, candleHandling.effectiveResolution);
    markStrategyReadyOnce(state, tickSnapshot);

    await this.syncBotState(bot);

    const action = evaluateEmaAtrTrail3mStrategy({
      state,
      closedCandleTs,
      marketId: config.marketId,
      maxPositionSize: config.maxPositionSize,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
      params: config.strategyParams,
    });

    if (action.type === "none") {
      logDebug("O1_STRATEGY_SKIP", "No strategy action for closed candle", {
        closedCandleTs,
        reason: action.reason,
      });
      return;
    }

    if (action.type === "openLong" || action.type === "openShort") {
      if (state.positionSize !== 0) {
        logDebug("O1_STRATEGY_SKIP", "Open blocked because a position is already open", {
          positionSize: state.positionSize,
          closedCandleTs,
        });
        return;
      }

      logInfo("O1_ENTRY", "Executing entry", {
        side: action.type === "openLong" ? "long" : "short",
        size: action.size,
        entryPrice: action.entryPrice,
        stopLoss: action.stopLoss,
        dryRun: config.dryRun,
      });

      const openResult = action.type === "openLong"
        ? await executor.openLong(action.size)
        : await executor.openShort(action.size);
      if (openResult.ok === false) {
        logError("O1_STRATEGY_ERROR", "Entry order failed", {
          side: action.type,
          reason: openResult.reason,
        });
        return;
      }

      await this.syncBotState(bot);
      if (state.positionSize === 0) {
        logError("O1_STRATEGY_ERROR", "Entry reported success but position is still flat", {
          side: action.type,
          size: action.size,
        });
        return;
      }

      const stopSide = action.type === "openLong" ? Side.Ask : Side.Bid;
      const stopSpec = state.strategy.activeStopLossSpec;
      if (!stopSpec) {
        logError("O1_STRATEGY_ERROR", "Missing stop-loss spec after entry", { side: action.type });
        await executor.closePosition();
        return;
      }

      logInfo("O1_SL", "Placing initial stop-loss", compactTriggerSpec(stopSpec));
      if (!config.dryRun) {
        const stopResult = await executor.placeStopLoss(stopSpec.triggerPrice, stopSide, stopSpec.limitBaseSize);
        if (stopResult.ok === false) {
          logError("O1_STRATEGY_ERROR", "Initial stop-loss placement failed; closing position", {
            reason: stopResult.reason,
          });
          await this.syncBotState(bot);
          await executor.closePosition();
          return;
        }
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
    };
  }
}
