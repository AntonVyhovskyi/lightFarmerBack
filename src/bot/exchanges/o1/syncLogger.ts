import { logInfo, logWarn } from "./logger";
import type { O1State } from "./types";

const SYNC_HEARTBEAT_MS = 60_000;

type SyncSnapshot = {
  positionSize: number;
  orders: number;
  balanceTotal: number;
};

let lastSnapshot: SyncSnapshot | null = null;
let lastLogAt = 0;

const snapshotFromState = (state: O1State): SyncSnapshot => ({
  positionSize: state.positionSize,
  orders: state.orders.length,
  balanceTotal: state.balanceTotal,
});

const changed = (left: SyncSnapshot, right: SyncSnapshot): boolean => {
  return left.positionSize !== right.positionSize || left.orders !== right.orders || left.balanceTotal !== right.balanceTotal;
};

export const logSyncFromFetch = (accountId: number, state: O1State): void => {
  const next = snapshotFromState(state);
  const now = Date.now();
  const stateChanged = lastSnapshot === null || changed(lastSnapshot, next);
  const heartbeatDue = now - lastLogAt >= SYNC_HEARTBEAT_MS;

  if (!stateChanged && !heartbeatDue) return;

  logInfo("O1_SYNC", stateChanged ? "State synchronized" : "State heartbeat", {
    accountId,
    positionSize: next.positionSize,
    orders: next.orders,
    balanceTotal: roundBalance(next.balanceTotal),
    heartbeat: !stateChanged,
  });

  lastSnapshot = next;
  lastLogAt = now;
};

export const logSyncStaleFallback = (payload: Record<string, unknown>): void => {
  logWarn("O1_SYNC", "Account stream stale; running fallback sync", payload);
  lastLogAt = Date.now();
};

export const logSyncFailure = (message: string, payload?: Record<string, unknown>): void => {
  logWarn("O1_SYNC", message, payload);
  lastLogAt = Date.now();
};

export const resetSyncLogger = (): void => {
  lastSnapshot = null;
  lastLogAt = 0;
};

const roundBalance = (value: number): number => Math.round(value * 100) / 100;
