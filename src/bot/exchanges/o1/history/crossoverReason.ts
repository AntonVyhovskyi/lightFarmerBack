import type { O1CrossoverReason } from "./types";

export const mapStrategyReasonToCrossoverReason = (reason: string): O1CrossoverReason | null => {
  switch (reason) {
    case "strength-below-threshold":
      return "skipped-strength-too-low";
    case "invalid-position-size":
    case "invalid-stop-distance":
      return "skipped-invalid-size";
    case "cooldown-active":
      return "skipped-cooldown";
    case "fee-below-minimum":
      return "skipped-other";
    case "max-trades-per-day":
      return "skipped-other";
    case "manage-only-no-new-entries":
      return "skipped-other";
    case "signal-found":
      return "signal_found";
    case "filters-passed":
      return "filters_passed";
    default:
      return null;
  }
};
