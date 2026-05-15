import type { CandleResolution, Nord, NordWebSocketClient, WebSocketAccountUpdate, WebSocketCandleUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import type { O1EnvConfig, O1State } from "./types";

const toCandle = (payload: WebSocketCandleUpdate): O1State["candles"][number] => {
  const tsMs = Number(payload.t) * 1000;
  return [
    String(tsMs),
    String(payload.o),
    String(payload.h),
    String(payload.l),
    String(payload.c),
    String(payload.v),
    String(tsMs),
    String(payload.v),
    "0",
    "0",
    "0",
    "0",
  ];
};

export type O1WsHandle = {
  start: () => void;
  stop: () => void;
};

export const createO1WsStreams = ({
  nord,
  config,
  state,
  candleStreamResolution,
  onCandle,
  onAccount,
  onTrade,
  onDisconnected,
}: {
  nord: Nord;
  config: O1EnvConfig;
  state: O1State;
  candleStreamResolution?: CandleResolution;
  onCandle: (candle: O1State["candles"][number], raw: WebSocketCandleUpdate) => void;
  onAccount: (payload: WebSocketAccountUpdate) => void;
  onTrade: (payload: WebSocketTradeUpdate) => void;
  onDisconnected: () => void;
}): O1WsHandle => {
  let candleWs: NordWebSocketClient | null = null;
  let accountWs: NordWebSocketClient | null = null;
  let tradesWs: NordWebSocketClient | null = null;

  const bindDisconnect = (name: "candle" | "account" | "trades", ws: NordWebSocketClient) => {
    ws.on("disconnected", () => {
      if (name === "candle") state.ws.candleConnected = false;
      if (name === "account") state.ws.accountConnected = false;
      if (name === "trades") state.ws.tradesConnected = false;
      logWarn("O1_WS", `${name} socket disconnected`, { stream: name });
      onDisconnected();
    });
    ws.on("error", (error) => {
      logError("O1_WS", `${name} socket error`, error);
    });
  };

  const start = () => {
    const streamResolution = candleStreamResolution ?? config.resolution;
    candleWs = nord.createWebSocketClient({
      candles: [{ symbol: config.symbol, resolution: streamResolution }],
    });
    candleWs.on("connected", () => {
      state.ws.candleConnected = true;
      logInfo("O1_WS", "Candle stream connected", {
        streamResolution,
        effectiveResolution: config.resolution,
      });
    });
    candleWs.on("candle", (payload) => {
      if (!payload || typeof payload !== "object") {
        logWarn("O1_CANDLE", "Malformed candle payload ignored");
        return;
      }
      const candle = toCandle(payload);
      state.ws.lastCandleUpdateAt = Date.now();
      onCandle(candle, payload);
    });
    bindDisconnect("candle", candleWs);
    candleWs.connect();

    accountWs = nord.createWebSocketClient({
      accounts: [config.accountId!],
    });
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
    bindDisconnect("account", accountWs);
    accountWs.connect();

    tradesWs = nord.createWebSocketClient({
      trades: [config.symbol],
    });
    tradesWs.on("connected", () => {
      state.ws.tradesConnected = true;
    });
    tradesWs.on("trade", (payload) => {
      state.ws.lastTradesUpdateAt = Date.now();
      onTrade(payload);
    });
    bindDisconnect("trades", tradesWs);
    tradesWs.connect();
  };

  const stop = () => {
    candleWs?.close();
    accountWs?.close();
    tradesWs?.close();
  };

  return { start, stop };
};
