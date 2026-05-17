import { logInfo } from "../logger";
import type { O1CrossoverDirection, O1CrossoverReason, O1CrossoverRecord } from "./types";

const MAX_CROSSOVERS = 200;

const crossovers: O1CrossoverRecord[] = [];
let idSeq = 0;

const nextId = (): string => {
  idSeq += 1;
  return `xo-${Date.now()}-${idSeq}`;
};

export const recordCrossover = (input: Omit<O1CrossoverRecord, "id" | "timestamp">): O1CrossoverRecord => {
  const record: O1CrossoverRecord = {
    ...input,
    id: nextId(),
    timestamp: Date.now(),
  };
  crossovers.unshift(record);
  if (crossovers.length > MAX_CROSSOVERS) {
    crossovers.pop();
  }
  logInfo("O1_CROSSOVER_RECORDED", "EMA crossover cached", {
    id: record.id,
    direction: record.direction,
    reason: record.reason,
    candleTs: record.candleTs,
    close: record.close,
  });
  return record;
};

export const listCrossovers = (opts?: {
  limit?: number;
  direction?: O1CrossoverDirection;
  reason?: O1CrossoverReason;
}): O1CrossoverRecord[] => {
  let rows = crossovers;
  if (opts?.direction) rows = rows.filter((row) => row.direction === opts.direction);
  if (opts?.reason) rows = rows.filter((row) => row.reason === opts.reason);
  if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
    return rows.slice(0, Math.max(0, opts.limit));
  }
  return [...rows];
};

export const getLastCrossover = (): O1CrossoverRecord | null => crossovers[0] ?? null;

export const getCrossoverCacheSize = (): number => crossovers.length;
