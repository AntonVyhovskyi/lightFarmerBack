import type { O1KnownReason, O1Result } from "./types";
import { logDebug, logError } from "./logger";

const RULES: Array<{ includes: string[]; reason: O1KnownReason; suggestion: string }> = [
  { includes: ["invalid", "empty", "session"], reason: "invalid_or_empty_session", suggestion: "Create or refresh Nord trading session before live order calls." },
  { includes: ["insufficient", "fund"], reason: "insufficient_funds", suggestion: "Lower size or deposit more collateral." },
  { includes: ["session", "signature", "expired", "invalid"], reason: "invalid_session_or_signature", suggestion: "Refresh session and reinitialize NordUser." },
  { includes: ["tick", "precision", "decimal"], reason: "precision_or_tick_error", suggestion: "Round price/size to market precision." },
  { includes: ["post", "would fill"], reason: "post_only_would_fill", suggestion: "Use limit away from spread or IOC." },
  { includes: ["ioc", "no fill"], reason: "ioc_no_fill", suggestion: "Try larger tolerance or different fill mode." },
  { includes: ["frozen", "market not ready", "halt"], reason: "market_not_ready", suggestion: "Pause bot until market recovers." },
  { includes: ["reduce", "only"], reason: "reduce_only_violation", suggestion: "Ensure position exists and side closes exposure." },
  { includes: ["stale", "timestamp", "price changed"], reason: "stale_timestamp_or_price", suggestion: "Sync account and price before retry." },
  { includes: ["risk", "health", "margin"], reason: "risk_or_account_unhealthy", suggestion: "Reduce leverage/size and verify account margin." },
  { includes: ["minimum", "size"], reason: "minimum_size_error", suggestion: "Increase order quantity above minimum." },
  { includes: ["price band", "band"], reason: "price_band_error", suggestion: "Use a price within allowed market bands." },
  { includes: ["conflict", "position", "open order"], reason: "position_order_conflict", suggestion: "Cancel conflicting orders first." },
  { includes: ["trigger"], reason: "trigger_execution_failed", suggestion: "Re-sync triggers and use fallback stop logic." },
];

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

export const normalizeO1Error = (err: unknown): O1Result<never> => {
  const text = err instanceof Error ? `${err.message} ${err.stack ?? ""}`.toLowerCase() : String(err).toLowerCase();
  const matched = RULES.find((rule) => rule.includes.every((token) => text.includes(token)));
  const reason: O1KnownReason = matched?.reason ?? "unknown_error";
  const suggestion = matched?.suggestion ?? "Check raw error and market/account status.";

  logDebug("O1_ERROR", "Normalized exchange error", {
    reason,
    suggestion,
    message: errorMessage(err),
  });

  return { ok: false, reason, suggestion, rawError: err };
};

export const logNormalizedFailure = (tag: string, message: string, result: O1Result<never>): void => {
  if (result.ok !== false) return;
  logError(tag, message, {
    reason: result.reason,
    suggestion: result.suggestion,
    message: result.rawError instanceof Error ? result.rawError.message : errorMessage(result.rawError),
    stack: result.rawError instanceof Error ? result.rawError.stack : undefined,
  });
};
