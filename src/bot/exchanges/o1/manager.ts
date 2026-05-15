import type { WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { Side } from "@n1xyz/nord-ts";
import { preloadO1Candles, usesAggregated3mCandles } from "./candlePreload";
import {
  describeCandleAlignment,
  detectClosed3mBucketMs,
  mergeLive1mIntoEffective3mCache,
} from "./candleAggregation";
import { upsertCandle } from "./candleCache";
import { initO1Client, resetO1Client } from "./client";
import { O1Executor } from "./executor";
import { o1Error, o1Log, o1Warn } from "./logger";
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
  usesAggregated3m: boolean;
  oneMinuteCandles: O1Candle[];
  lastOneMinuteTs: number | null;
  lastClosed3mTickTs: number | null;
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

    const usesAggregated3m = usesAggregated3mCandles(config.resolution);
    const oneMinuteCandles: O1Candle[] = [];
    let lastOneMinuteTs: number | null = null;
    let lastClosed3mTickTs: number | null = null;
    const live1mBufferMax = 12;

    const preloadedCandles = await preloadO1Candles(config);
    state.candles = [...preloadedCandles];
    state.candlePreloaded = preloadedCandles.length > 0;
    state.preloadedCandleCount = preloadedCandles.length;
    if (preloadedCandles.length > 0) {
      state.lastPrice = Number(preloadedCandles[preloadedCandles.length - 1][4]);
    }

    if (usesAggregated3m) {
      o1Log("O1_CANDLE_PRELOAD_AGGREGATED", "Preloaded 3m history loaded into effective cache.", {
        preloaded3mCandleCount: state.preloadedCandleCount,
        effective3mCandleCacheSize: state.candles.length,
        latestPreloaded3mTs: state.candles.length > 0 ? Number(state.candles[state.candles.length - 1]?.[0]) : null,
      });

      if (config.strategyName === EMA_ATR_TRAIL_3M_STRATEGY_NAME && state.candles.length > 0) {
        const lastPreloadedTs = Number(state.candles[state.candles.length - 1]![0]);
        const snapshot = buildEmaAtrTrail3mTickSnapshot(state, lastPreloadedTs);
        markStrategyReadyOnce(state, snapshot);
      }
    }

    const reconnect = () => {
      const bot = this.bots.get(botId);
      if (!bot) return;
      const { reconnectCount } = bot.state.ws;
      if (reconnectCount >= config.reconnectAttemptsMax) {
        o1Error("O1_WS_RECONNECT", "Reconnect attempts exceeded max limit.", { reconnectCount });
        return;
      }
      bot.state.ws.reconnectCount += 1;
      bot.state.ws.lastReconnectAttemptAt = Date.now();
      const delay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** reconnectCount);
      o1Warn("O1_WS_RECONNECT", "Scheduling reconnect.", { delay, reconnectCount });
      bot.reconnectTimer = setTimeout(() => bot.wsHandle?.start(), delay);
    };

    const wsHandle = createO1WsStreams({
      nord,
      config,
      state,
      candleStreamResolution: usesAggregated3m ? "1" : config.resolution,
      onCandle: (candle) => {
        if (usesAggregated3m) {
          const sourceTs = Number(candle[0]);
          const previousLatest1mTs = lastOneMinuteTs;
          upsertCandle(oneMinuteCandles, candle, live1mBufferMax);
          lastOneMinuteTs = sourceTs;

          const mergeResult = mergeLive1mIntoEffective3mCache(state.candles, oneMinuteCandles, config.maxCandleCache);
          state.lastPrice = Number(candle[4]);

          const closedCandleTs = detectClosed3mBucketMs(oneMinuteCandles, previousLatest1mTs, sourceTs);
          const diagnostics = {
            source1mBufferSize: oneMinuteCandles.length,
            effective3mCandleCacheSize: state.candles.length,
            preloaded3mCandleCount: state.preloadedCandleCount,
            latestClosed3mCandleTs: closedCandleTs,
            latestLive3mBucketTs: mergeResult.latestLive3mBucketTs,
            mergedBucketKeys: mergeResult.mergedBucketKeys,
            formingBucketBarCount: mergeResult.formingBucketBarCount,
            alignment: describeCandleAlignment(sourceTs),
          };

          o1Log("O1_CANDLE_LIVE_AGGREGATED", "Merged live 1m into effective 3m cache.", diagnostics);

          if (closedCandleTs !== null && closedCandleTs !== lastClosed3mTickTs) {
            lastClosed3mTickTs = closedCandleTs;
            o1Log("O1_CLOSED_3M_CANDLE", "Closed 3m candle detected.", diagnostics);
            void this.tick(botId, closedCandleTs);
          }
          return;
        }

        const ts = Number(candle[0]);
        const previousLatestTs = state.candles.length > 0 ? Number(state.candles[state.candles.length - 1]?.[0]) : null;
        upsertCandle(state.candles, candle, config.maxCandleCache);
        state.lastPrice = Number(candle[4]);
        o1Log("O1_CANDLE_UPDATE", "Candle cache updated.", { ts, size: state.candles.length, price: state.lastPrice });
        const closedCandleTs = previousLatestTs !== null && ts > previousLatestTs ? previousLatestTs : null;
        if (closedCandleTs !== null) {
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
      if (!wsStale) return;

      const sinceLastFallbackMs = now - state.ws.lastFallbackSyncAt;
      if (sinceLastFallbackMs < fallbackSyncIntervalMs) {
        o1Log("O1_SYNC", "Account stream stale but fallback sync throttled.", {
          accountAgeMs,
          wsStaleMs: config.wsStaleMs,
          sinceLastFallbackMs,
          fallbackSyncIntervalMs,
          accountWsConnected: state.ws.accountConnected,
          accountWsHasPayload: state.accountWsHasPayload,
          lastAccountPayloadAt: state.ws.lastAccountPayloadAt,
          lastAccountConnectAt: state.ws.lastAccountConnectAt,
        });
        return;
      }

      o1Warn("O1_SYNC", "Account stream stale, running fallback sync.", {
        accountAgeMs,
        wsStaleMs: config.wsStaleMs,
        accountWsConnected: state.ws.accountConnected,
        accountWsHasPayload: state.accountWsHasPayload,
        lastAccountPayloadAt: state.ws.lastAccountPayloadAt,
        lastAccountConnectAt: state.ws.lastAccountConnectAt,
      });
      state.ws.lastFallbackSyncAt = now;
      await executor.syncAccount();
      this.syncStateFromUser(state, user, config.marketId, config.accountId!);
    }, Math.max(5000, Math.floor(config.wsStaleMs / 2)));

    const stop = async () => {
      wsHandle.stop();
      if (this.bots.get(botId)?.heartbeatTimer) clearInterval(this.bots.get(botId)!.heartbeatTimer);
      if (this.bots.get(botId)?.reconnectTimer) clearTimeout(this.bots.get(botId)!.reconnectTimer);
      this.bots.delete(botId);
      resetO1Client();
      o1Log("O1_STOP", "Stopped O1 bot.");
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
      usesAggregated3m,
      oneMinuteCandles,
      lastOneMinuteTs,
      lastClosed3mTickTs,
    });

    return botId;
  }

  private async tick(botId: string, closedCandleTs?: number): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;
    const { state, executor, config } = bot;
    if (state.emergencyStop) return;

    if (config.strategyName === EMA_ATR_TRAIL_3M_STRATEGY_NAME) {
      if (String(config.resolution) !== "3") {
        o1Log("O1_STRATEGY_SKIP", "EMA ATR trail strategy requires O1_RESOLUTION=3.", {
          resolution: config.resolution,
        });
        return;
      }
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
    const { state, executor, config } = bot;
    const tickSnapshot = buildEmaAtrTrail3mTickSnapshot(state, closedCandleTs);
    logEmaAtrTrail3mTick(tickSnapshot);
    markStrategyReadyOnce(state, tickSnapshot);

    await this.syncBotState(bot);

    const action = evaluateEmaAtrTrail3mStrategy({
      state,
      closedCandleTs,
      marketId: config.marketId,
      maxPositionSize: config.maxPositionSize,
      priceDecimals: bot.priceDecimals,
      sizeDecimals: bot.sizeDecimals,
    });

    if (action.type === "none") {
      o1Log("O1_STRATEGY_SKIP", "No strategy action for closed candle.", {
        closedCandleTs,
        reason: action.reason,
      });
      return;
    }

    if (action.type === "openLong" || action.type === "openShort") {
      if (state.positionSize !== 0) {
        o1Log("O1_STRATEGY_SKIP", "Open blocked because a position is already open.", {
          positionSize: state.positionSize,
          closedCandleTs,
        });
        return;
      }

      const openResult = action.type === "openLong"
        ? await executor.openLong(action.size)
        : await executor.openShort(action.size);
      if (!openResult.ok) {
        o1Error("O1_STRATEGY_ERROR", "Entry order failed.", { action, result: openResult });
        return;
      }

      await this.syncBotState(bot);
      if (state.positionSize === 0) {
        o1Error("O1_STRATEGY_ERROR", "Entry reported success but position is still flat.", { action });
        return;
      }

      const stopSide = action.type === "openLong" ? Side.Ask : Side.Bid;
      const stopSpec = state.strategy.activeStopLossSpec;
      if (!stopSpec) {
        o1Error("O1_STRATEGY_ERROR", "Missing stop-loss spec after entry.", { action });
        await executor.closePosition();
        return;
      }

      if (config.dryRun) {
        o1Log("O1_ORDER_DRY_RUN", "Dry-run hypothetical initial stop-loss.", stopSpec);
      } else {
        const stopResult = await executor.placeStopLoss(stopSpec.triggerPrice, stopSide, stopSpec.limitBaseSize);
        if (!stopResult.ok) {
          o1Error("O1_STRATEGY_ERROR", "Initial stop-loss placement failed; closing position.", {
            action,
            stopSpec,
            result: stopResult,
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
        o1Error("O1_STRATEGY_ERROR", "Trailing update requested without active stop-loss spec.", { action });
        return;
      }

      const nextSpec = {
        ...currentSpec,
        triggerPrice: action.stopLoss,
      };

      if (config.dryRun) {
        o1Log("O1_ORDER_DRY_RUN", "Dry-run hypothetical trailing stop-loss update.", {
          previous: currentSpec,
          next: nextSpec,
        });
        state.strategy.activeStopLossSpec = nextSpec;
        return;
      }

      const updateResult = await executor.updateStopLoss(currentSpec, nextSpec);
      if (!updateResult.ok) {
        o1Error("O1_STRATEGY_ERROR", "Trailing stop-loss update failed.", { action, result: updateResult });
        return;
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
    o1Log("O1_ACCOUNT_UPDATE", "Account update processed.", {
      orders: state.orders.length,
      balanceTotal: state.balanceTotal,
      receivedAt: now,
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
    o1Log("O1_SYNC", "State synchronized from fetchInfo.", {
      accountId,
      positionSize: state.positionSize,
      orders: state.orders.length,
    });
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
    const { config } = bot;
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
      ws: {
        ...state.ws,
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
