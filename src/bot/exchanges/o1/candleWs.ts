import WebSocket from "ws";
import type { WebSocketCandleUpdate } from "@n1xyz/nord-ts";
import { logDebug, logError, logWarn } from "./logger";
import type { O1Candle, O1State } from "./types";

export type RelaxedCandlePayload = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  res?: string;
  mid?: number;
  market_id?: number;
};

export const toWsBaseUrl = (url: string): string => {
  return url.replace(/\/$/, "").replace(/^http/i, "ws");
};

export const buildCandleSubscriptionUrl = (wsUrl: string, symbol: string, resolution: string): string => {
  return `${toWsBaseUrl(wsUrl)}/ws/candle@${symbol}:${resolution}`;
};

export const isRelaxedCandlePayload = (payload: unknown): payload is RelaxedCandlePayload => {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as RelaxedCandlePayload;
  return (
    typeof candidate.t === "number"
    && typeof candidate.o === "number"
    && typeof candidate.h === "number"
    && typeof candidate.l === "number"
    && typeof candidate.c === "number"
    && typeof candidate.v === "number"
  );
};

export const normalizeCandlePayload = (
  payload: RelaxedCandlePayload,
  marketId: number
): WebSocketCandleUpdate => {
  const mid = payload.mid ?? payload.market_id ?? marketId;
  return {
    ...payload,
    mid,
    res: payload.res ?? "",
  } as WebSocketCandleUpdate;
};

export const candlePayloadToO1Candle = (payload: Pick<WebSocketCandleUpdate, "t" | "o" | "h" | "l" | "c" | "v">): O1Candle => {
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

export type O1CandleWsHandle = {
  connect: () => void;
  close: () => void;
};

export const createO1CandleWebSocket = ({
  wsUrl,
  symbol,
  resolution,
  marketId,
  state,
  onCandle,
  onConnected,
  onDisconnected,
}: {
  wsUrl: string;
  symbol: string;
  resolution: string;
  marketId: number;
  state: O1State;
  onCandle: (candle: O1Candle, raw: WebSocketCandleUpdate) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}): O1CandleWsHandle => {
  let socket: WebSocket | null = null;
  let firstPayloadLogged = false;

  const close = (): void => {
    if (!socket) return;
    socket.removeAllListeners();
    socket.close();
    socket = null;
    state.ws.candleConnected = false;
  };

  const connect = (): void => {
    close();
    const url = buildCandleSubscriptionUrl(wsUrl, symbol, resolution);
    logDebug("O1_CANDLE_WS", "Connecting candle stream", { url, symbol, resolution });

    socket = new WebSocket(url);

    socket.on("open", () => {
      state.ws.candleConnected = true;
      onConnected?.();
    });

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as unknown;
        if (!isRelaxedCandlePayload(message)) {
          logWarn("O1_CANDLE_WS", "Ignored non-candle websocket payload", {
            keys: message && typeof message === "object" ? Object.keys(message as object) : [],
          });
          return;
        }

        const normalized = normalizeCandlePayload(message, marketId);
        const candle = candlePayloadToO1Candle(normalized);
        state.ws.lastCandleUpdateAt = Date.now();

        if (!firstPayloadLogged) {
          firstPayloadLogged = true;
          logDebug("O1_CANDLE_WS", "First candle payload received", {
            ts: normalized.t,
            res: normalized.res,
            mid: normalized.mid,
          });
        }

        onCandle(candle, normalized);
      } catch (error) {
        logError("O1_CANDLE_WS", "Failed to parse candle websocket payload", error);
      }
    });

    socket.on("close", () => {
      state.ws.candleConnected = false;
      onDisconnected?.();
    });

    socket.on("error", (error) => {
      logError("O1_CANDLE_WS", "Candle websocket error", error);
    });
  };

  return { connect, close };
};
