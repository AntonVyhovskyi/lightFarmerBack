import type { NordUser } from "@n1xyz/nord-ts";
import { normalizeO1Error } from "./errors";
import { applyO1Uint8ArrayToHexPolyfill, hasUint8ArrayToHex } from "./hexPolyfill";
import { o1Error, o1Log } from "./logger";
import type { O1Result } from "./types";

const isSessionReady = (user: NordUser): boolean => {
  return user.sessionId !== undefined && user.sessionId !== BigInt(0);
};

const prepareSessionSigning = (): void => {
  applyO1Uint8ArrayToHexPolyfill();
  o1Log("O1_SESSION_HEX", "Uint8Array.toHex availability before session refresh.", {
    present: hasUint8ArrayToHex(),
  });
};

export const ensureO1TradingSession = async (user: NordUser, dryRun: boolean): Promise<O1Result> => {
  if (dryRun) return { ok: true };

  try {
    if (isSessionReady(user)) {
      o1Log("O1_SESSION_READY", "Trading session is available.", {
        sessionIdPresent: true,
        walletPubkey: user.publicKey.toBase58(),
      });
      return { ok: true };
    }

    o1Log("O1_SESSION_CREATE", "Creating Nord trading session.", {
      walletPubkey: user.publicKey.toBase58(),
    });
    prepareSessionSigning();
    await user.refreshSession();

    if (!isSessionReady(user)) {
      throw new Error("Session refresh completed without a valid session ID.");
    }

    o1Log("O1_SESSION_READY", "Trading session is ready.", {
      sessionIdPresent: true,
      walletPubkey: user.publicKey.toBase58(),
    });
    return { ok: true };
  } catch (err) {
    o1Error("O1_SESSION_ERROR", "Failed to prepare Nord trading session.", {
      walletPubkey: user.publicKey.toBase58(),
    });
    return normalizeO1Error(err);
  }
};

export const refreshO1TradingSession = async (user: NordUser, dryRun: boolean): Promise<O1Result> => {
  if (dryRun) return { ok: true };

  try {
    o1Log("O1_SESSION_REFRESH", "Refreshing Nord trading session.", {
      walletPubkey: user.publicKey.toBase58(),
    });
    prepareSessionSigning();
    await user.refreshSession();

    if (!isSessionReady(user)) {
      throw new Error("Session refresh completed without a valid session ID.");
    }

    o1Log("O1_SESSION_READY", "Trading session is ready.", {
      sessionIdPresent: true,
      walletPubkey: user.publicKey.toBase58(),
    });
    return { ok: true };
  } catch (err) {
    o1Error("O1_SESSION_ERROR", "Failed to refresh Nord trading session.", {
      walletPubkey: user.publicKey.toBase58(),
    });
    return normalizeO1Error(err);
  }
};
