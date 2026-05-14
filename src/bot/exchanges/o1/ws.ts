import type { Nord, NordWebSocketClient, WebSocketAccountUpdate, WebSocketCandleUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import type { O1EnvConfig, O1State } from "./types";
import { o1Error, o1Log, o1Warn } from "./logger";

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
  onCandle,
  onAccount,
  onTrade,
  onDisconnected,
}: {
  nord: Nord;
  config: O1EnvConfig;
  state: O1State;
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
      o1Warn("O1_WS_RECONNECT", `${name} socket disconnected, scheduling reconnect.`);
      onDisconnected();
    });
    ws.on("error", (error) => {
      o1Error("O1_WS_RECONNECT", `${name} socket error.`, { error: String(error) });
    });
  };

  const start = () => {
    candleWs = nord.createWebSocketClient({
      candles: [{ symbol: config.symbol, resolution: config.resolution }],
    });
    candleWs.on("connected", () => {
      state.ws.candleConnected = true;
      o1Log("O1_WS_CANDLE_CONNECTED", "Candle stream connected.");
    });
    candleWs.on("candle", (payload) => {
      if (!payload || typeof payload !== "object") {
        o1Warn("O1_CANDLE_UPDATE", "Malformed candle payload ignored.");
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
      o1Log("O1_DEBUG_WS", "Account subscription prepared.", {
        stream: `account@${config.accountId}`,
        accountId: config.accountId,
        marketId: config.marketId,
        symbol: config.symbol,
      });
    }
    accountWs.on("connected", () => {
      state.ws.accountConnected = true;
      o1Log("O1_WS_ACCOUNT_CONNECTED", "Account stream connected.");
      if (config.debugWs) {
        o1Log("O1_DEBUG_WS", "Account websocket connected.", {
          stream: `account@${config.accountId}`,
        });
      }
    });
    accountWs.on("account", (payload) => {
      state.ws.lastAccountUpdateAt = Date.now();
      if (config.debugWs) {
        o1Log("O1_DEBUG_WS", "Account websocket payload received.", {
          accountId: payload.account_id,
          updateId: payload.update_id,
          placeCount: Object.keys(payload.places ?? {}).length,
          cancelCount: Object.keys(payload.cancels ?? {}).length,
          fillCount: Object.keys(payload.fills ?? {}).length,
          balanceCount: Object.keys(payload.balances ?? {}).length,
        });
      }
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
