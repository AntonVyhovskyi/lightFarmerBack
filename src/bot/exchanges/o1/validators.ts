import { FillMode, Side } from "@n1xyz/nord-ts";
import type { O1EnvConfig, O1PlaceOrderRequest, O1Result, O1State } from "./types";

const isFinitePositive = (value: number | undefined): boolean => Number.isFinite(value) && Number(value) > 0;

export const validatePreTrade = (
  config: O1EnvConfig,
  state: O1State,
  params: O1PlaceOrderRequest
): O1Result => {
  if (!config.enabled) return { ok: false, reason: "O1 bot disabled by env flag." };
  if (state.emergencyStop) return { ok: false, reason: "Emergency stop enabled." };
  if (state.blockNewEntries && !params.isReduceOnly) {
    return { ok: false, reason: "New entries blocked (safe mode)." };
  }
  if (!Number.isFinite(params.marketId) || params.marketId < 0) return { ok: false, reason: "Invalid marketId." };
  if (!Object.values(Side).includes(params.side)) return { ok: false, reason: "Invalid side." };
  if (!Object.values(FillMode).includes(params.fillMode)) return { ok: false, reason: "Invalid fillMode." };
  if (!isFinitePositive(state.lastPrice)) return { ok: false, reason: "Last price unavailable." };
  if (Date.now() - state.ws.lastCandleUpdateAt > config.candleStaleMs) return { ok: false, reason: "Candle stream stale." };
  if (state.candles.length < 100) return { ok: false, reason: "Not enough candle history." };
  if (params.size !== undefined && !isFinitePositive(params.size)) return { ok: false, reason: "Order size must be positive." };
  if (params.price !== undefined && !isFinitePositive(params.price)) return { ok: false, reason: "Order price must be positive." };

  const notional = (params.price ?? state.lastPrice) * (params.size ?? 0);
  if (notional > config.maxOrderNotional) return { ok: false, reason: "Order notional exceeds configured maximum." };
  if (Math.abs(state.positionSize) > config.maxPositionSize) return { ok: false, reason: "Position exceeds configured maximum." };

  if (!params.isReduceOnly) {
    if (state.lastOrderAt && Date.now() - state.lastOrderAt < config.cooldownMs) {
      return { ok: false, reason: "Entry cooldown active." };
    }

    if (params.clientOrderId && state.pendingClientOrderIds.has(params.clientOrderId)) {
      return { ok: false, reason: "Duplicate clientOrderId detected." };
    }
  }

  if (params.isReduceOnly) {
    if (state.positionSize === 0) return { ok: false, reason: "Reduce-only order with no position." };
    const invalidReduceLong = state.positionSize > 0 && params.side !== Side.Ask;
    const invalidReduceShort = state.positionSize < 0 && params.side !== Side.Bid;
    if (invalidReduceLong || invalidReduceShort) {
      return { ok: false, reason: "Reduce-only side does not match current position direction." };
    }
  }

  return { ok: true };
};

export const validateClosePosition = (
  config: O1EnvConfig,
  state: O1State,
  params: O1PlaceOrderRequest
): O1Result => {
  if (!config.enabled) return { ok: false, reason: "O1 bot disabled by env flag." };
  if (!params.isReduceOnly) return { ok: false, reason: "closePosition must be reduce-only." };
  if (state.positionSize === 0) return { ok: false, reason: "No position to close." };
  if (!Number.isFinite(params.marketId) || params.marketId < 0) return { ok: false, reason: "Invalid marketId." };
  if (!Object.values(Side).includes(params.side)) return { ok: false, reason: "Invalid side." };
  if (!Object.values(FillMode).includes(params.fillMode)) return { ok: false, reason: "Invalid fillMode." };
  if (params.size === undefined || !isFinitePositive(params.size)) return { ok: false, reason: "Close size must be positive." };
  if (params.size > Math.abs(state.positionSize)) return { ok: false, reason: "Close size exceeds open position." };

  const invalidReduceLong = state.positionSize > 0 && params.side !== Side.Ask;
  const invalidReduceShort = state.positionSize < 0 && params.side !== Side.Bid;
  if (invalidReduceLong || invalidReduceShort) {
    return { ok: false, reason: "Reduce-only side does not match current position direction." };
  }

  return { ok: true };
};

export const validateSafetyGuardrails = (config: O1EnvConfig, state: O1State): O1Result => {
  if (state.dailyRealizedPnl <= -Math.abs(config.dailyLossLimit)) {
    return { ok: false, reason: "Daily loss limit reached." };
  }
  if (Date.now() - state.ws.lastAccountUpdateAt > config.wsStaleMs) {
    return { ok: false, reason: "Account stream stale or desynced." };
  }
  return { ok: true };
};
