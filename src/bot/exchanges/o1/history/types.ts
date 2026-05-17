export type O1CrossoverDirection = "long" | "short";

export type O1CrossoverReason =
  | "entered"
  | "skipped-strength-too-low"
  | "skipped-existing-position"
  | "skipped-cooldown"
  | "skipped-invalid-size"
  | "skipped-max-notional"
  | "skipped-dry-run"
  | "skipped-executor-error"
  | "skipped-other";

export type O1EntryStatus =
  | "attempted"
  | "opened"
  | "failed"
  | "closed-by-safety";

export type O1CrossoverRecord = {
  id: string;
  timestamp: number;
  candleTs: number;
  symbol: string;
  resolution: string;
  candleMode: "direct" | "aggregated";
  direction: O1CrossoverDirection;
  close: number;
  emaShort: number;
  emaLong: number;
  atr: number;
  strengthPct: number | null;
  strengthConfirmationPct: number;
  positionSize: number;
  balanceTotal: number;
  riskPct: number;
  calculatedSize: number | null;
  stopLoss: number | null;
  reason: O1CrossoverReason;
  details: Record<string, unknown>;
};

export type O1EntryRecord = {
  id: string;
  crossoverId: string | null;
  timestamp: number;
  candleTs: number;
  symbol: string;
  resolution: string;
  direction: O1CrossoverDirection;
  entryPrice: number;
  size: number;
  notional: number;
  leverage: number;
  stopLoss: number | null;
  dryRun: boolean;
  orderResult: string | null;
  slTriggerResult: string | null;
  status: O1EntryStatus;
  failureReason: string | null;
};

export type O1HistoryDiagnostics = {
  crossoverCacheSize: number;
  entryCacheSize: number;
  lastCrossover: O1CrossoverRecord | null;
  lastEntry: O1EntryRecord | null;
};
