import { getCrossoverCacheSize, getLastCrossover, listCrossovers, recordCrossover } from "./crossoverCache";
import { getEntryCacheSize, getLastEntry, listEntries, recordEntry } from "./entryCache";
import { getRejectionCounters } from "./rejectionCounters";
import type {
  O1CrossoverDirection,
  O1CrossoverReason,
  O1CrossoverRecord,
  O1EntryRecord,
  O1EntryStatus,
  O1HistoryDiagnostics,
} from "./types";

export type {
  O1CrossoverDirection,
  O1CrossoverReason,
  O1CrossoverRecord,
  O1EntryRecord,
  O1EntryStatus,
  O1HistoryDiagnostics,
};

export { listCrossovers, listEntries, recordCrossover, recordEntry };
export { getRejectionCounters, incrementRejection, resetRejectionCounters } from "./rejectionCounters";

export type { O1PipelineStageCounts } from "./types";

export const getPipelineStageCounts = (): import("./types").O1PipelineStageCounts => {
  const crossovers = listCrossovers();
  const entries = listEntries();
  const countReason = (reason: string) => crossovers.filter((c) => c.reason === reason).length;
  return {
    signal_found: countReason("signal_found"),
    filters_passed: countReason("filters_passed"),
    order_attempted: countReason("order_attempted"),
    order_accepted: countReason("order_accepted"),
    position_confirmed: countReason("position_confirmed"),
    entered_confirmed: countReason("entered_confirmed"),
    entered_confirmed_entries: entries.filter((e) => e.status === "opened").length,
  };
};

export const getO1HistoryDiagnostics = (): O1HistoryDiagnostics => ({
  crossoverCacheSize: getCrossoverCacheSize(),
  entryCacheSize: getEntryCacheSize(),
  lastCrossover: getLastCrossover(),
  lastEntry: getLastEntry(),
  rejectionCounters: getRejectionCounters(),
  pipelineStages: getPipelineStageCounts(),
  runtimeCrossoverNote:
    "Runtime cache only records crossovers while the bot process is running; use crossoverAnalysis for full candle-history scan.",
});
