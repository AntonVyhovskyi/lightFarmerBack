import type { CandleResolution } from "@n1xyz/nord-ts";
import type { O1EnvConfig } from "./types";

const asBool = (value: string | undefined, fallback = false): boolean => {
  if (!value) return fallback;
  return value.toLowerCase() === "true" || value === "1";
};

const asNum = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toResolution = (value: string | undefined): CandleResolution => {
  const fallback: CandleResolution = "1";
  if (!value) return fallback;
  const allowed = ["1", "3", "5", "15", "30", "60", "4H", "1D", "1W", "1M"];
  return (allowed.includes(value) ? value : fallback) as CandleResolution;
};

export const readO1Env = (): O1EnvConfig => ({
  enabled: asBool(process.env.O1_ENABLED, false),
  dryRun: asBool(process.env.O1_DRY_RUN, true),
  emergencyStop: asBool(process.env.O1_EMERGENCY_STOP, false),
  privateKey: process.env.O1_PRIVATE_KEY ?? "",
  appKey: process.env.O1_APP_KEY ?? "",
  solanaRpcUrl: process.env.O1_SOLANA_RPC_URL ?? "",
  webServerUrl: process.env.O1_WEB_SERVER_URL ?? "https://zo-devnet.n1.xyz",
  wsUrl: process.env.O1_WS_URL ?? "wss://zo-mainnet.n1.xyz",
  accountId: process.env.O1_ACCOUNT_ID ? Number(process.env.O1_ACCOUNT_ID) : undefined,
  marketId: asNum(process.env.O1_MARKET_ID, 0),
  symbol: process.env.O1_SYMBOL ?? "BTCUSDC",
  resolution: toResolution(process.env.O1_RESOLUTION),
  strategyName: process.env.O1_STRATEGY ?? "conservativeEma",
  riskPct: asNum(process.env.O1_RISK_PCT, 0.5),
  defaultLeverage: asNum(process.env.O1_DEFAULT_LEVERAGE, 1),
  maxPositionSize: asNum(process.env.O1_MAX_POSITION_SIZE, 10),
  maxOrderNotional: asNum(process.env.O1_MAX_ORDER_NOTIONAL, 10000),
  maxCandleCache: asNum(process.env.O1_MAX_CANDLE_CACHE, 500),
  candleStaleMs: asNum(process.env.O1_CANDLE_STALE_MS, 180000),
  wsStaleMs: asNum(process.env.O1_WS_STALE_MS, 45000),
  cooldownMs: asNum(process.env.O1_COOLDOWN_MS, 30000),
  reconnectBaseMs: asNum(process.env.O1_RECONNECT_BASE_MS, 1000),
  reconnectMaxMs: asNum(process.env.O1_RECONNECT_MAX_MS, 30000),
  reconnectAttemptsMax: asNum(process.env.O1_RECONNECT_ATTEMPTS_MAX, 30),
  dailyLossLimit: asNum(process.env.O1_DAILY_LOSS_LIMIT, 100),
  debugWs: asBool(process.env.O1_DEBUG_WS, false),
});

export const validateO1Env = (config: O1EnvConfig): string[] => {
  const missing: string[] = [];

  if (!config.privateKey) missing.push("O1_PRIVATE_KEY");
  if (!config.appKey) missing.push("O1_APP_KEY");
  if (!config.solanaRpcUrl) missing.push("O1_SOLANA_RPC_URL");
  if (!config.webServerUrl) missing.push("O1_WEB_SERVER_URL");
  if (!config.wsUrl) missing.push("O1_WS_URL");
  if (!Number.isFinite(config.marketId) || config.marketId < 0) missing.push("O1_MARKET_ID");
  if (!config.symbol) missing.push("O1_SYMBOL");
  if (!Number.isFinite(config.riskPct) || config.riskPct <= 0 || config.riskPct > 100) missing.push("O1_RISK_PCT");
  if (!Number.isFinite(config.maxPositionSize) || config.maxPositionSize <= 0) missing.push("O1_MAX_POSITION_SIZE");
  if (!Number.isFinite(config.maxOrderNotional) || config.maxOrderNotional <= 0) missing.push("O1_MAX_ORDER_NOTIONAL");

  return missing;
};
