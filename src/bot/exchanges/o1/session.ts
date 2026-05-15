import type { NordUser } from "@n1xyz/nord-ts";
import { normalizeO1Error } from "./errors";
import { applyO1Uint8ArrayToHexPolyfill, hasUint8ArrayToHex } from "./hexPolyfill";
import { logDebug, logError, logInfo } from "./logger";
import type { O1Result } from "./types";

const isSessionReady = (user: NordUser): boolean => {
  return user.sessionId !== undefined && user.sessionId !== BigInt(0);
};

const prepareSessionSigning = (): void => {
  applyO1Uint8ArrayToHexPolyfill();
  logDebug("O1_SESSION", "Uint8Array.toHex availability before session refresh", {
    present: hasUint8ArrayToHex(),
  });
};

export const ensureO1TradingSession = async (user: NordUser, dryRun: boolean): Promise<O1Result> => {
  if (dryRun) return { ok: true };

  try {
    if (isSessionReady(user)) {
      logDebug("O1_SESSION", "Trading session already available");
      return { ok: true };
    }

    logInfo("O1_SESSION", "Creating Nord trading session");
    prepareSessionSigning();
    await user.refreshSession();

    if (!isSessionReady(user)) {
      throw new Error("Session refresh completed without a valid session ID.");
    }

    logInfo("O1_SESSION", "Trading session ready");
    return { ok: true };
  } catch (err) {
    logError("O1_SESSION", "Failed to prepare Nord trading session", err);
    return normalizeO1Error(err);
  }
};

export const refreshO1TradingSession = async (user: NordUser, dryRun: boolean): Promise<O1Result> => {
  if (dryRun) return { ok: true };

  try {
    logInfo("O1_SESSION", "Refreshing Nord trading session");
    prepareSessionSigning();
    await user.refreshSession();

    if (!isSessionReady(user)) {
      throw new Error("Session refresh completed without a valid session ID.");
    }

    logInfo("O1_SESSION", "Trading session refreshed");
    return { ok: true };
  } catch (err) {
    logError("O1_SESSION", "Failed to refresh Nord trading session", err);
    return normalizeO1Error(err);
  }
};
