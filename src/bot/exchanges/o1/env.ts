import type { CandleResolution } from "@n1xyz/nord-ts";
import { O1_SUPPORTED_RESOLUTIONS } from "./candleResolution";
import type { O1EnvConfig, O1EmaAtrTrailStrategyParams } from "./types";

const asBool = (value: string | undefined, fallback = false): boolean => {
  if (!value) return fallback;
  return value.toLowerCase() === "true" || value === "1";
};

const asNum = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toResolution = (value: string | undefined): CandleResolution => {
  return (value ?? "1") as CandleResolution;
};

const readStrategyParams = (): O1EmaAtrTrailStrategyParams => ({
  emaShortPeriod: asInt(process.env.O1_EMA_SHORT_PERIOD, 7),
  emaLongPeriod: asInt(process.env.O1_EMA_LONG_PERIOD, 25),
  atrPeriod: asInt(process.env.O1_ATR_PERIOD, 14),
  strengthConfirmationPct: asNum(process.env.O1_STRENGTH_CONFIRMATION_PCT, 0.5),
  riskPct: asNum(process.env.O1_RISK_PCT, 1),
  atrStopMultiplier: asNum(process.env.O1_ATR_STOP_MULTIPLIER, 2.5),
  trailingStartPct: asNum(process.env.O1_TRAILING_START_PCT, 1),
  trailingGapPct: asNum(process.env.O1_TRAILING_GAP_PCT, 0.5),
  leverage: asNum(process.env.O1_DEFAULT_LEVERAGE, 7),
  strengthLookbackCandles: asInt(process.env.O1_STRENGTH_LOOKBACK_CANDLES, 5),
});

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
  strategyParams: readStrategyParams(),
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
  candlePollIntervalMs: asNum(process.env.O1_CANDLE_POLL_MS, 20_000),
  manageExistingPositionOnly: asBool(process.env.O1_MANAGE_EXISTING_POSITION_ONLY, false),
});

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export const validateO1StrategyParams = (params: O1EmaAtrTrailStrategyParams): string[] => {
  const invalid: string[] = [];

  if (!Number.isInteger(params.emaShortPeriod) || params.emaShortPeriod < 1) {
    invalid.push("O1_EMA_SHORT_PERIOD must be a positive integer");
  }
  if (!Number.isInteger(params.emaLongPeriod) || params.emaLongPeriod < 1) {
    invalid.push("O1_EMA_LONG_PERIOD must be a positive integer");
  }
  if (params.emaShortPeriod >= params.emaLongPeriod) {
    invalid.push("O1_EMA_SHORT_PERIOD must be less than O1_EMA_LONG_PERIOD");
  }
  if (!Number.isInteger(params.atrPeriod) || params.atrPeriod < 1) {
    invalid.push("O1_ATR_PERIOD must be a positive integer");
  }
  if (!Number.isFinite(params.strengthConfirmationPct) || params.strengthConfirmationPct < 0) {
    invalid.push("O1_STRENGTH_CONFIRMATION_PCT must be >= 0");
  }
  if (!isPositive(params.riskPct) || params.riskPct > 100) {
    invalid.push("O1_RISK_PCT must be > 0 and <= 100");
  }
  if (!isPositive(params.atrStopMultiplier)) {
    invalid.push("O1_ATR_STOP_MULTIPLIER must be > 0");
  }
  if (!isPositive(params.trailingStartPct)) {
    invalid.push("O1_TRAILING_START_PCT must be > 0");
  }
  if (!isPositive(params.trailingGapPct)) {
    invalid.push("O1_TRAILING_GAP_PCT must be > 0");
  }
  if (!isPositive(params.leverage)) {
    invalid.push("O1_DEFAULT_LEVERAGE must be > 0");
  }
  if (!Number.isInteger(params.strengthLookbackCandles) || params.strengthLookbackCandles < 1) {
    invalid.push("O1_STRENGTH_LOOKBACK_CANDLES must be a positive integer");
  }

  return invalid;
};

export const validateO1Env = (config: O1EnvConfig): string[] => {
  const missing: string[] = [];

  if (!config.privateKey) missing.push("O1_PRIVATE_KEY");
  if (!config.appKey) missing.push("O1_APP_KEY");
  if (!config.solanaRpcUrl) missing.push("O1_SOLANA_RPC_URL");
  if (!config.webServerUrl) missing.push("O1_WEB_SERVER_URL");
  if (!config.wsUrl) missing.push("O1_WS_URL");
  if (!Number.isFinite(config.marketId) || config.marketId < 0) missing.push("O1_MARKET_ID");
  if (!config.symbol) missing.push("O1_SYMBOL");

  const resolution = String(config.resolution);
  if (!O1_SUPPORTED_RESOLUTIONS.includes(resolution as (typeof O1_SUPPORTED_RESOLUTIONS)[number])) {
    missing.push(`O1_RESOLUTION (supported: ${O1_SUPPORTED_RESOLUTIONS.join(", ")})`);
  }

  if (!Number.isFinite(config.riskPct) || config.riskPct <= 0 || config.riskPct > 100) missing.push("O1_RISK_PCT");
  if (!Number.isFinite(config.maxPositionSize) || config.maxPositionSize <= 0) missing.push("O1_MAX_POSITION_SIZE");
  if (!Number.isFinite(config.maxOrderNotional) || config.maxOrderNotional <= 0) missing.push("O1_MAX_ORDER_NOTIONAL");

  missing.push(...validateO1StrategyParams(config.strategyParams));

  return missing;
};
