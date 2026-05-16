import { logInfo, logWarn } from "./logger";
import type { O1State } from "./types";

const SYNC_HEARTBEAT_MS = 60_000;
const STALE_FALLBACK_HEARTBEAT_MS = 5 * 60_000;

type SyncSnapshot = {
  positionSize: number;
  orders: number;
  balanceTotal: number;
};

type WsAccountState = {
  accountWsConnected: boolean;
  accountWsHasPayload: boolean;
};

export type StaleFallbackLogContext = {
  accountAgeMs: number;
  wsStaleMs: number;
  accountWsConnected: boolean;
  accountWsHasPayload: boolean;
};

let lastSnapshot: SyncSnapshot | null = null;
let lastFetchLogAt = 0;

let streamWasStale = false;
let lastWsAccountState: WsAccountState | null = null;
let lastStaleLogAt = 0;

const snapshotFromState = (state: O1State): SyncSnapshot => ({
  positionSize: state.positionSize,
  orders: state.orders.length,
  balanceTotal: state.balanceTotal,
});

const changed = (left: SyncSnapshot, right: SyncSnapshot): boolean => {
  return left.positionSize !== right.positionSize || left.orders !== right.orders || left.balanceTotal !== right.balanceTotal;
};

const roundBalance = (value: number): number => Math.round(value * 100) / 100;

const compactStaleContext = (ctx: StaleFallbackLogContext): Record<string, unknown> => ({
  accountAgeMs: Math.round(ctx.accountAgeMs),
  wsStaleMs: ctx.wsStaleMs,
  accountWsConnected: ctx.accountWsConnected,
  accountWsHasPayload: ctx.accountWsHasPayload,
});

const pickStaleLogReason = (ctx: StaleFallbackLogContext, now: number): string | null => {
  const wsState: WsAccountState = {
    accountWsConnected: ctx.accountWsConnected,
    accountWsHasPayload: ctx.accountWsHasPayload,
  };

  if (!streamWasStale) {
    streamWasStale = true;
    lastWsAccountState = wsState;
    return "first_stale";
  }

  if (
    lastWsAccountState !== null &&
    (lastWsAccountState.accountWsConnected !== wsState.accountWsConnected ||
      lastWsAccountState.accountWsHasPayload !== wsState.accountWsHasPayload)
  ) {
    lastWsAccountState = wsState;
    return "ws_state_changed";
  }

  lastWsAccountState = wsState;

  if (now - lastStaleLogAt >= STALE_FALLBACK_HEARTBEAT_MS) {
    return "heartbeat";
  }

  return null;
};

export const markAccountStreamHealthy = (): void => {
  streamWasStale = false;
};

export const logSyncFromFetch = (accountId: number, state: O1State): void => {
  const next = snapshotFromState(state);
  const now = Date.now();
  const stateChanged = lastSnapshot === null || changed(lastSnapshot, next);
  const heartbeatDue = now - lastFetchLogAt >= SYNC_HEARTBEAT_MS;

  if (!stateChanged && !heartbeatDue) return;

  logInfo("O1_SYNC", stateChanged ? "State synchronized" : "State heartbeat", {
    accountId,
    positionSize: next.positionSize,
    orders: next.orders,
    balanceTotal: roundBalance(next.balanceTotal),
    heartbeat: !stateChanged,
  });

  lastSnapshot = next;
  lastFetchLogAt = now;
};

/** Log stale fallback only on first stale, WS state change, failure, or 5m heartbeat. */
export const logSyncStaleFallbackIfNeeded = (ctx: StaleFallbackLogContext): void => {
  const reason = pickStaleLogReason(ctx, Date.now());
  if (reason === null) return;

  logWarn("O1_SYNC", "Account stream stale; running fallback sync", {
    ...compactStaleContext(ctx),
    reason,
  });
  lastStaleLogAt = Date.now();
};

export const logSyncStaleFallbackFailed = (ctx: StaleFallbackLogContext, failureReason: string): void => {
  logWarn("O1_SYNC", "Fallback sync failed while account stream stale", {
    ...compactStaleContext(ctx),
    reason: "fetch_failed",
    failureReason,
  });
  lastStaleLogAt = Date.now();
};

export const resetSyncLogger = (): void => {
  lastSnapshot = null;
  lastFetchLogAt = 0;
  streamWasStale = false;
  lastWsAccountState = null;
  lastStaleLogAt = 0;
};
