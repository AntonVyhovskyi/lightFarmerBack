import type { O1CrossoverReason } from "./types";

export const mapStrategyReasonToCrossoverReason = (reason: string): O1CrossoverReason | null => {
  switch (reason) {
    case "strength-below-threshold":
      return "skipped-strength-too-low";
    case "invalid-position-size":
      return "skipped-invalid-size";
    case "manage-only-no-new-entries":
      return "skipped-other";
    default:
      return null;
  }
};
