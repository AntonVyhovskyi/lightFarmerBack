import type { WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { preloadO1Candles } from "./candlePreload";
import { upsertCandle } from "./candleCache";
import { initO1Client, resetO1Client } from "./client";
import { O1Executor } from "./executor";
import { o1Error, o1Log, o1Warn } from "./logger";
import { createInitialO1State } from "./state";
import { getO1ConservativeEmaSignal } from "./strategyAdapter";
import type { O1Diagnostics, O1EnvConfig, O1State } from "./types";
import { createO1WsStreams, type O1WsHandle } from "./ws";

type O1BotEntry = {
  id: string;
  state: O1State;
  stop: () => Promise<void>;
  executor: O1Executor;
  pubkey: string;
  wsHandle?: O1WsHandle;
  reconnectTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  config: O1EnvConfig;
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

    const preloadedCandles = await preloadO1Candles(config);
    state.candles = preloadedCandles;
    state.candlePreloaded = preloadedCandles.length > 0;
    state.preloadedCandleCount = preloadedCandles.length;
    if (preloadedCandles.length > 0) {
      state.lastPrice = Number(preloadedCandles[preloadedCandles.length - 1][4]);
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
      onCandle: (candle) => {
        const ts = Number(candle[0]);
        upsertCandle(state.candles, candle, config.maxCandleCache);
        state.lastPrice = Number(candle[4]);
        o1Log("O1_CANDLE_UPDATE", "Candle cache updated.", { ts, size: state.candles.length, price: state.lastPrice });
        void this.tick(botId);
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

    const heartbeatTimer = setInterval(async () => {
      const wsStale = Date.now() - state.ws.lastAccountUpdateAt > config.wsStaleMs;
      if (wsStale) {
        o1Warn("O1_SYNC", "Account stream stale, running fallback sync.");
        await executor.syncAccount();
        this.syncStateFromUser(state, user, config.marketId, config.accountId!);
      }
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
      pubkey: user.publicKey.toBase58(),
      wsHandle,
      heartbeatTimer,
      config,
    });

    return botId;
  }

  private async tick(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;
    const { state, executor, config } = bot;
    if (state.emergencyStop) return;
    if (state.lastSignalCandleTs === Number(state.candles[state.candles.length - 1]?.[0])) return;

    const signal = getO1ConservativeEmaSignal({
      state,
      riskPct: config.riskPct,
      maxPositionSize: config.maxPositionSize,
    });
    state.lastSignalCandleTs = Number(state.candles[state.candles.length - 1]?.[0] ?? 0);

    if (signal.type === "openLong") await executor.openLong(signal.size);
    else if (signal.type === "openShort") await executor.openShort(signal.size);
    else if (signal.type === "closePosition") await executor.closePosition();
  }

  private handleAccountUpdate(state: O1State, payload: WebSocketAccountUpdate, marketId: number): void {
    state.accountWsHasPayload = true;
    state.accountStateSource = "websocket";
    state.ws.lastAccountUpdateAt = Date.now();
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
    await bot.executor.syncAccount();
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
    };
  }
}
