import { initWebSocketClient, type NordWebSocketClient, WebSocketAccountUpdate, WebSocketTradeUpdate } from "@n1xyz/nord-ts";
import type { CandleResolution } from "@n1xyz/nord-ts";
import { isRelaxedCandlePayload, normalizeCandlePayload, candlePayloadToO1Candle, toWsBaseUrl } from "./candleWs";
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
  let candleWs: NordWebSocketClient | null = null;
  let accountWs: NordWebSocketClient | null = null;
  let tradesWs: NordWebSocketClient | null = null;

  const httpBaseUrl = config.webServerUrl.replace(/\/$/, "");
  const streamResolution = String(candleStreamResolution ?? config.resolution);

  const bindNordDisconnect = (name: "candle" | "account" | "trades", ws: NordWebSocketClient) => {
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

  const handleCandlePayload = (payload: unknown): void => {
    const nested = payload && typeof payload === "object" && "candle" in payload
      ? (payload as { candle?: unknown }).candle
      : payload;
    if (!isRelaxedCandlePayload(nested)) {
      logWarn("O1_CANDLE_WS", "Ignored non-candle websocket payload", {
        keys: payload && typeof payload === "object" ? Object.keys(payload as object) : [],
      });
      return;
    }
    const normalized = normalizeCandlePayload(nested, config.marketId);
    const candle = candlePayloadToO1Candle(normalized);
    state.ws.lastCandleUpdateAt = Date.now();
    onCandle(candle, normalized);
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

    const candleSubscription = `candle@${config.symbol}:${streamResolution}`;
    candleWs = initWebSocketClient(httpBaseUrl, [candleSubscription]);
    candleWs.on("connected", () => {
      state.ws.candleConnected = true;
      logInfo("O1_WS", "Candle stream connected", {
        streamResolution,
        effectiveResolution: config.resolution,
        subscription: candleSubscription,
        wsUrl: `${toWsBaseUrl(config.wsUrl || config.webServerUrl)}/ws/${candleSubscription}`,
      });
      onCandleConnected?.();
    });
    candleWs.on("candle", (payload) => {
      logDebug("O1_CANDLE_WS", "Candle payload received", {
        ts: payload.t,
        res: payload.res,
        mid: payload.mid,
      });
      handleCandlePayload(payload);
    });
    bindNordDisconnect("candle", candleWs);

    accountWs = initWebSocketClient(httpBaseUrl, [`account@${config.accountId!}`]);
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
      });
      onAccount(payload);
    });
    bindNordDisconnect("account", accountWs);

    tradesWs = initWebSocketClient(httpBaseUrl, [`trades@${config.symbol}`]);
    tradesWs.on("connected", () => {
      state.ws.tradesConnected = true;
    });
    tradesWs.on("trades", (payload) => {
      state.ws.lastTradesUpdateAt = Date.now();
      onTrade(payload);
    });
    bindNordDisconnect("trades", tradesWs);
  };

  return { start, stop };
};
