import type { CandleResolution, FillMode, Side, TriggerKind } from "@n1xyz/nord-ts";
import type { O1HistoryDiagnostics } from "./history/types";
import type { O1StrategyDiagnostics } from "./strategies/types";

export type O1Candle = [
  openTimeMs: string,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  closeTimeMs: string,
  quoteVolume: string,
  numberOfTrades: string,
  takerBuyBase: string,
  takerBuyQuote: string,
  ignored: string
];

export type O1EmaAtrTrailStrategyParams = {
  emaShortPeriod: number;
  emaLongPeriod: number;
  atrPeriod: number;
  strengthConfirmationPct: number;
  riskPct: number;
  atrStopMultiplier: number;
  trailingStartPct: number;
  trailingGapPct: number;
  leverage: number;
  strengthLookbackCandles: number;
};

export type O1EmaCrossoverAtrLiveParams = {
  emaShortPeriod: number;
  emaLongPeriod: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  riskPct: number;
  leverage: number;
  breakEvenPct: number;
  trailingStartPct: number;
  trailingGapPct: number;
  cooldownCandles: number;
  minMoveVsFeeMult: number;
  feeRate: number;
  maxTradesPerDay: number;
  takeProfitPct: number;
  maxHoldCandles: number;
  exitOnOppositeSignal: boolean;
  strengthLookbackCandles: number;
  minStopDistancePct: number;
};

export type O1StrategyParams = O1EmaAtrTrailStrategyParams | O1EmaCrossoverAtrLiveParams;

export type O1EnvConfig = {
  enabled: boolean;
  dryRun: boolean;
  emergencyStop: boolean;
  blockNewEntries: boolean;
  privateKey: string;
  appKey: string;
  solanaRpcUrl: string;
  webServerUrl: string;
  wsUrl: string;
  accountId?: number;
  marketId: number;
  symbol: string;
  resolution: CandleResolution;
  strategyName: string;
  riskPct: number;
  defaultLeverage: number;
  strategyParams: O1StrategyParams;
  maxPositionSize: number;
  maxOrderNotional: number;
  maxCandleCache: number;
  candleStaleMs: number;
  wsStaleMs: number;
  cooldownMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectAttemptsMax: number;
  dailyLossLimit: number;
  debugWs: boolean;
  candlePollIntervalMs: number;
  manageExistingPositionOnly: boolean;
  /** 0 = disabled. Flat-only maintenance restart interval. */
  scheduledRestartIntervalHours: number;
  /** Pause between stop and start during scheduled restart. */
  scheduledRestartCooldownMs: number;
};

export type O1WsStatuses = {
  candleConnected: boolean;
  accountConnected: boolean;
  tradesConnected: boolean;
  lastCandleUpdateAt: number;
  lastAccountUpdateAt: number;
  lastTradesUpdateAt: number;
  lastReconnectAttemptAt: number;
  reconnectCount: number;
  lastAccountPayloadAt: number;
  lastAccountConnectAt: number;
  lastFallbackSyncAt: number;
};

export type O1Order = {
  orderId: number;
  marketId: number;
  side: "ask" | "bid";
  size: number;
  price: number;
  originalOrderSize: number;
  clientOrderId: number | null;
};

export type O1Position = {
  marketId: number;
  openOrders: number;
  perp?: {
    baseSize: number;
    price: number;
    updatedFundingRateIndex: number;
    fundingPaymentPnl: number;
    sizePricePnl: number;
    isLong: boolean;
  };
  actionId: number;
};

export type O1State = {
  candles: O1Candle[];
  orders: O1Order[];
  positionSize: number;
  entryPrice: number;
  balanceTotal: number;
  balanceAvailable: number;
  lastPrice: number;
  beActive: boolean;
  trailingActive: boolean;
  lastSignalCandleTs: number | null;
  lastOrderAt: number | null;
  lastSyncAt: number | null;
  pendingClientOrderIds: Set<number>;
  ws: O1WsStatuses;
  emergencyStop: boolean;
  blockNewEntries: boolean;
  dailyRealizedPnl: number;
  candlePreloaded: boolean;
  preloadedCandleCount: number;
  accountWsHasPayload: boolean;
  accountStateSource: "fetchInfo" | "websocket";
  strategy: O1StrategyDiagnostics;
  lastStopGuardAt: number;
};

export type O1PlaceOrderRequest = {
  marketId: number;
  side: Side;
  fillMode: FillMode;
  isReduceOnly: boolean;
  size?: number;
  price?: number;
  quoteSize?: number;
  clientOrderId?: number;
};

export type O1Result<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; reason: string; rawError?: unknown; suggestion?: string };

export type O1KnownReason =
  | "insufficient_funds"
  | "invalid_session_or_signature"
  | "invalid_or_empty_session"
  | "precision_or_tick_error"
  | "post_only_would_fill"
  | "ioc_no_fill"
  | "market_not_ready"
  | "reduce_only_violation"
  | "stale_timestamp_or_price"
  | "risk_or_account_unhealthy"
  | "minimum_size_error"
  | "price_band_error"
  | "position_order_conflict"
  | "trigger_execution_failed"
  | "unknown_error";

export type O1TriggerSpec = {
  marketId: number;
  side: Side;
  kind: TriggerKind;
  triggerPrice: number;
  triggerId?: bigint;
  limitPrice?: number;
  limitBaseSize?: number;
  limitQuoteSize?: number;
};

export type O1Diagnostics = {
  env: {
    enabled: boolean;
    dryRun: boolean;
    emergencyStop: boolean;
    solanaRpcUrl: string;
    webServerUrl: string;
    wsUrl: string;
    marketId: number;
    symbol: string;
    resolution: CandleResolution;
    accountId?: number;
    strategyName: string;
    riskPct: number;
    defaultLeverage: number;
    emaShortPeriod?: number;
    emaLongPeriod?: number;
  };
  candles: {
    configuredResolution: string;
    effectiveResolution: string;
    candleMode: "direct" | "aggregated";
    streamResolution: string;
  };
  strategyParams: O1StrategyParams;
  initialized: {
    nord: boolean;
    user: boolean;
  };
  user: {
    pubkey?: string;
    accountId?: number;
  };
  account: {
    balanceTotal: number;
    balanceAvailable: number;
    positionSize: number;
    entryPrice: number;
    openOrders: number;
  };
  market: {
    lastPrice: number;
    lastCandleTs: number;
    candleCacheSize: number;
    candlePreloaded: boolean;
    preloadedCandleCount: number;
  };
  ws: O1WsStatuses & {
    accountAgeMs: number | null;
    accountWsConnected: boolean;
    accountWsHasPayload: boolean;
    accountStateSource: "fetchInfo" | "websocket";
  };
  safety: {
    emergencyStop: boolean;
    blockNewEntries: boolean;
    dryRun: boolean;
    pendingOrders: number;
    cooldownMs: number;
  };
  strategy: O1StrategyDiagnostics;
  history: O1HistoryDiagnostics;
  crossoverAnalysis?: {
    strategyName: string;
    symbol: string;
    resolution: string;
    candleMode: string;
    emaShortPeriod: number;
    emaLongPeriod: number;
    atrPeriod: number;
    strengthLookbackCandles: number;
    candlesLoaded: number;
    firstCandleTs: number | null;
    lastCandleTs: number | null;
    scannedCandleCount: number;
    warmupSkippedCount: number;
    totalCrosses: number;
    longCrosses: number;
    shortCrosses: number;
    last20CrossoverCandidates: import("./crossoverAnalysis").HistoricalCrossoverEvent[];
  };
  poll: {
    intervalMs: number;
    lastPollIngestedTs: number | null;
    enabled: boolean;
  };
};
