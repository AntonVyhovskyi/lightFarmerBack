import { getCrossoverCacheSize, getLastCrossover, listCrossovers, recordCrossover } from "./crossoverCache";
import { getEntryCacheSize, getLastEntry, listEntries, recordEntry } from "./entryCache";
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

export const getO1HistoryDiagnostics = (): O1HistoryDiagnostics => ({
  crossoverCacheSize: getCrossoverCacheSize(),
  entryCacheSize: getEntryCacheSize(),
  lastCrossover: getLastCrossover(),
  lastEntry: getLastEntry(),
});
