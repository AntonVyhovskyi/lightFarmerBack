import { initWebSocketClient, type NordWebSocketClient, WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import type { CandleResolution } from "@n1xyz/nord-ts";
import { createO1CandleWebSocket, toWsBaseUrl, type O1CandleWsHandle } from "./candleWs";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import type { O1EnvConfig, O1State } from "./types";

export type O1WsHandle = {
  start: () => void;
  stop: () => void;
};

export const createO1WsStreams = ({
  config,
  state,
  candleStreamResolution,
  onCandle,
  onCandleConnected,
  onAccount,
  onTrade,
  onDisconnected,
}: {
  config: O1EnvConfig;
  state: O1State;
  candleStreamResolution?: CandleResolution;
  onCandle: (candle: O1State["candles"][number], raw: unknown) => void;
  onCandleConnected?: () => void;
  onAccount: (payload: WebSocketAccountUpdate) => void;
  onTrade: (payload: WebSocketTradeUpdate) => void;
  onDisconnected: () => void;
}): O1WsHandle => {
  let candleWs: O1CandleWsHandle | null = null;
  let accountWs: NordWebSocketClient | null = null;
  let tradesWs: NordWebSocketClient | null = null;

  const wsBaseUrl = config.wsUrl || config.webServerUrl;

  const bindNordDisconnect = (name: "account" | "trades", ws: NordWebSocketClient) => {
    ws.on("disconnected", () => {
      if (name === "account") state.ws.accountConnected = false;
      if (name === "trades") state.ws.tradesConnected = false;
      logWarn("O1_WS", `${name} socket disconnected`, { stream: name });
      onDisconnected();
    });
    ws.on("error", (error) => {
      logError("O1_WS", `${name} socket error`, error);
    });
  };

  const stop = () => {
    candleWs?.close();
    candleWs = null;
    accountWs?.close();
    accountWs = null;
    tradesWs?.close();
    tradesWs = null;
    state.ws.candleConnected = false;
    state.ws.accountConnected = false;
    state.ws.tradesConnected = false;
  };

  const start = () => {
    stop();

    const streamResolution = String(candleStreamResolution ?? config.resolution);
    candleWs = createO1CandleWebSocket({
      wsUrl: wsBaseUrl,
      symbol: config.symbol,
      resolution: streamResolution,
      marketId: config.marketId,
      state,
      onCandle,
      onConnected: () => {
        logInfo("O1_WS", "Candle stream connected", {
          streamResolution,
          effectiveResolution: config.resolution,
          wsUrl: toWsBaseUrl(wsBaseUrl),
        });
        onCandleConnected?.();
      },
      onDisconnected: () => {
        logWarn("O1_WS", "candle socket disconnected", { stream: "candle" });
        onDisconnected();
      },
    });
    candleWs.connect();

    accountWs = initWebSocketClient(wsBaseUrl, [`account@${config.accountId!}`]);
    if (config.debugWs) {
      logDebug("O1_WS", "Account subscription prepared", {
        accountId: config.accountId,
        marketId: config.marketId,
        symbol: config.symbol,
      });
    }
    accountWs.on("connected", () => {
      const now = Date.now();
      state.ws.accountConnected = true;
      state.ws.lastAccountConnectAt = now;
      state.ws.lastAccountUpdateAt = now;
      logInfo("O1_WS", "Account stream connected", { connectedAt: now });
    });
    accountWs.on("account", (payload) => {
      const now = Date.now();
      state.ws.lastAccountUpdateAt = now;
      state.ws.lastAccountPayloadAt = now;
      logDebug("O1_WS", "Account payload received", {
        updateId: payload.update_id,
        places: Object.keys(payload.places ?? {}).length,
        cancels: Object.keys(payload.cancels ?? {}).length,
        fills: Object.keys(payload.fills ?? {}).length,
      });
      onAccount(payload);
    });
    bindNordDisconnect("account", accountWs);
    accountWs.connect();

    tradesWs = initWebSocketClient(wsBaseUrl, [`trades@${config.symbol}`]);
    tradesWs.on("connected", () => {
      state.ws.tradesConnected = true;
    });
    tradesWs.on("trade", (payload) => {
      state.ws.lastTradesUpdateAt = Date.now();
      onTrade(payload);
    });
    bindNordDisconnect("trades", tradesWs);
    tradesWs.connect();
  };

  return { start, stop };
};
