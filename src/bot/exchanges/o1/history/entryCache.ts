import { logInfo } from "../logger";
import type { O1CrossoverDirection, O1EntryRecord, O1EntryStatus } from "./types";

const MAX_ENTRIES = 50;

const entries: O1EntryRecord[] = [];
let idSeq = 0;

const nextId = (): string => {
  idSeq += 1;
  return `en-${Date.now()}-${idSeq}`;
};

export const recordEntry = (input: Omit<O1EntryRecord, "id" | "timestamp">): O1EntryRecord => {
  const record: O1EntryRecord = {
    ...input,
    id: nextId(),
    timestamp: Date.now(),
  };
  entries.unshift(record);
  if (entries.length > MAX_ENTRIES) {
    entries.pop();
  }
  logInfo("O1_ENTRY_RECORDED", "Entry attempt cached", {
    id: record.id,
    crossoverId: record.crossoverId,
    status: record.status,
    direction: record.direction,
    size: record.size,
    dryRun: record.dryRun,
  });
  return record;
};

export const listEntries = (opts?: {
  limit?: number;
  direction?: O1CrossoverDirection;
  status?: O1EntryStatus;
}): O1EntryRecord[] => {
  let rows = entries;
  if (opts?.direction) rows = rows.filter((row) => row.direction === opts.direction);
  if (opts?.status) rows = rows.filter((row) => row.status === opts.status);
  if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
    return rows.slice(0, Math.max(0, opts.limit));
  }
  return [...rows];
};

export const getLastEntry = (): O1EntryRecord | null => entries[0] ?? null;

export const getEntryCacheSize = (): number => entries.length;
