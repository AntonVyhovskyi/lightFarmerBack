import type { O1PlaceOrderRequest, O1TriggerSpec } from "./types";

export type O1LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<O1LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_PAYLOAD_CHARS = 1200;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 8;

const throttleLastAt = new Map<string, number>();

const parseLogLevel = (value: string | undefined): O1LogLevel => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
};

let configuredLevel: O1LogLevel | null = null;

export const getO1LogLevel = (): O1LogLevel => {
  if (configuredLevel === null) {
    configuredLevel = parseLogLevel(process.env.O1_LOG_LEVEL);
  }
  return configuredLevel;
};

export const resetO1LogLevelForTests = (): void => {
  configuredLevel = null;
};

const shouldLog = (level: O1LogLevel): boolean => {
  return LEVEL_RANK[level] >= LEVEL_RANK[getO1LogLevel()];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Error);
};

const serializeError = (error: Error): Record<string, unknown> => {
  const cause = (error as Error & { cause?: unknown }).cause;
  const payload: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) payload.stack = error.stack;
  if (cause !== undefined) {
    payload.cause = cause instanceof Error ? serializeError(cause) : sanitizeValue(cause, 0);
  }
  return payload;
};

const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object") return value;

  if (depth >= MAX_DEPTH) return "[MaxDepth]";

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) sliced.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return sliced;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].slice(0, MAX_ARRAY_ITEMS).map(([k, v]) => [String(k), sanitizeValue(v, depth + 1)]));
  }
  if (value instanceof Set) {
    return [...value].slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "rawError" && depth === 0) continue;
    output[key] = sanitizeValue(entry, depth + 1);
  }
  return output;
};

const compactPayload = (payload: unknown): string => {
  if (payload === undefined) return "";
  const sanitized = sanitizeValue(payload, 0);
  try {
    let json = JSON.stringify(sanitized);
    if (json.length > MAX_PAYLOAD_CHARS) {
      json = `${json.slice(0, MAX_PAYLOAD_CHARS - 3)}...`;
    }
    return json === "{}" ? "" : ` ${json}`;
  } catch {
    return " {\"serialization\":\"failed\"}";
  }
};

const writeLine = (level: O1LogLevel, tag: string, message: string, payload?: unknown): void => {
  if (!shouldLog(level)) return;
  const line = `[${tag}] ${message}${compactPayload(payload)}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
};

export const logDebug = (tag: string, message: string, payload?: unknown): void => {
  writeLine("debug", tag, message, payload);
};

export const logInfo = (tag: string, message: string, payload?: unknown): void => {
  writeLine("info", tag, message, payload);
};

export const logWarn = (tag: string, message: string, payload?: unknown): void => {
  writeLine("warn", tag, message, payload);
};

export const logError = (tag: string, message: string, errorOrPayload?: unknown): void => {
  if (errorOrPayload instanceof Error) {
    writeLine("error", tag, message, serializeError(errorOrPayload));
    return;
  }
  if (isPlainObject(errorOrPayload) && errorOrPayload.error instanceof Error) {
    writeLine("error", tag, message, {
      ...errorOrPayload,
      error: serializeError(errorOrPayload.error),
    });
    return;
  }
  writeLine("error", tag, message, errorOrPayload);
};

export const logThrottle = (tag: string, intervalMs: number, fn: () => void): void => {
  const now = Date.now();
  const last = throttleLastAt.get(tag) ?? 0;
  if (now - last < intervalMs) return;
  throttleLastAt.set(tag, now);
  fn();
};

/** @deprecated Use logInfo */
export const o1Log = logInfo;
/** @deprecated Use logWarn */
export const o1Warn = logWarn;
/** @deprecated Use logError */
export const o1Error = logError;

export const compactOrderRequest = (req: O1PlaceOrderRequest): Record<string, unknown> => ({
  marketId: req.marketId,
  side: req.side,
  fillMode: req.fillMode,
  reduceOnly: req.isReduceOnly,
  size: req.size,
  price: req.price,
  quoteSize: req.quoteSize,
  clientOrderId: req.clientOrderId,
});

export const compactTriggerSpec = (spec: O1TriggerSpec): Record<string, unknown> => ({
  marketId: spec.marketId,
  side: spec.side,
  kind: spec.kind,
  triggerId: spec.triggerId?.toString(),
  triggerPrice: spec.triggerPrice,
  limitPrice: spec.limitPrice,
  limitBaseSize: spec.limitBaseSize,
  limitQuoteSize: spec.limitQuoteSize,
});

export const compactCandleDiagnostics = (input: {
  source1mBufferSize: number;
  effective3mCandleCacheSize: number;
  preloaded3mCandleCount: number;
  latestClosed3mCandleTs: number | null;
  latestLive3mBucketTs: number | null;
  formingBucketBarCount: number;
}): Record<string, unknown> => ({
  source1mBufferSize: input.source1mBufferSize,
  effective3mCandleCacheSize: input.effective3mCandleCacheSize,
  preloaded3mCandleCount: input.preloaded3mCandleCount,
  latestClosed3mCandleTs: input.latestClosed3mCandleTs,
  latestLive3mBucketTs: input.latestLive3mBucketTs,
  formingBucketBarCount: input.formingBucketBarCount,
});

export const roundMetric = (value: number | null | undefined, digits = 4): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
