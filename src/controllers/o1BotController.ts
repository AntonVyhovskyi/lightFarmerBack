import { Request, Response } from "express";
import { listCrossovers, listEntries } from "../bot/exchanges/o1/history";
import type { O1CrossoverDirection, O1CrossoverReason, O1EntryStatus } from "../bot/exchanges/o1/history/types";
import { O1BotManager } from "../bot/exchanges/o1/manager";
import { sanitizeForApi } from "../bot/exchanges/o1/logger";

const parseLimit = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const o1BotManager = new O1BotManager();

const serializeError = (err: unknown) => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: err };
};

export const startO1BotController = async (_req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  if (!enabled) {
    console.log("[O1_DISABLED] O1 start blocked by env flag.");
    return res.status(400).json({ ok: false, reason: "O1_DISABLED" });
  }
  try {
    const botId = await o1BotManager.start();
    return res.status(200).json({ enabled, botId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to start O1 bot", details: serializeError(err) });
  }
};

export const stopO1BotController = async (req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  const { botId } = req.body as { botId?: string };
  try {
    const result = await o1BotManager.safeStop(botId);
    return res.status(200).json({
      enabled,
      message: result.stopped ? "O1 bot stopped" : "O1 bot stop completed with errors",
      ...result,
    });
  } catch (err) {
    return res.status(200).json({
      enabled,
      stopped: false,
      cleanupErrors: [serializeError(err)],
      remainingBots: await o1BotManager.getBots().catch(() => []),
      details: serializeError(err),
    });
  }
};

export const getO1CrossoversController = async (req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  const limit = parseLimit(req.query.limit);
  const direction = typeof req.query.direction === "string"
    ? req.query.direction as O1CrossoverDirection
    : undefined;
  const reason = typeof req.query.reason === "string"
    ? req.query.reason as O1CrossoverReason
    : undefined;
  try {
    const crossovers = listCrossovers({ limit, direction, reason });
    return res.status(200).json({ enabled, count: crossovers.length, crossovers });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch O1 crossovers", details: serializeError(err) });
  }
};

export const getO1EntriesController = async (req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  const limit = parseLimit(req.query.limit);
  const direction = typeof req.query.direction === "string"
    ? req.query.direction as O1CrossoverDirection
    : undefined;
  const status = typeof req.query.status === "string"
    ? req.query.status as O1EntryStatus
    : undefined;
  try {
    const entries = listEntries({ limit, direction, status });
    return res.status(200).json({ enabled, count: entries.length, entries });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch O1 entries", details: serializeError(err) });
  }
};

export const getO1BotsController = async (_req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  try {
    const bots = await o1BotManager.getBots();
    return res.status(200).json({ enabled, bots });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch O1 bots", details: serializeError(err) });
  }
};

export const getO1DiagnosticsController = async (req: Request, res: Response) => {
  const enabled = process.env.O1_ENABLED === "true";
  const botId = typeof req.params.botId === "string" ? req.params.botId : req.params.botId?.[0];
  if (!botId) return res.status(400).json({ error: "botId is required" });
  try {
    const { diagnostics, diagnosticsError } = await o1BotManager.getSafeDiagnostics(botId);
    return res.status(200).json({
      enabled,
      diagnostics,
      ...(diagnosticsError ? { diagnosticsError } : {}),
    });
  } catch (err) {
    return res.status(200).json({
      enabled,
      diagnostics: null,
      diagnosticsError: err instanceof Error ? err.message : String(err),
      details: sanitizeForApi(serializeError(err)),
    });
  }
};

export const forceO1SyncController = async (req: Request, res: Response) => {
  const { botId } = req.body as { botId?: string };
  if (!botId) return res.status(400).json({ error: "botId is required" });
  try {
    await o1BotManager.forceSync(botId);
    return res.status(200).json({ message: "O1 sync completed" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to sync O1 bot", details: serializeError(err) });
  }
};

export const setO1EmergencyStopController = async (req: Request, res: Response) => {
  const { botId, enabled } = req.body as { botId?: string; enabled?: boolean };
  if (!botId || enabled === undefined) return res.status(400).json({ error: "botId and enabled are required" });
  try {
    o1BotManager.setEmergencyStop(botId, Boolean(enabled));
    if (Boolean(enabled)) {
      o1BotManager.setBlockNewEntries(botId, true);
    }
    return res.status(200).json({
      message: "Emergency stop updated",
      botId,
      enabled: Boolean(enabled),
      blockNewEntries: Boolean(enabled),
    });
  } catch (err) {
    return res.status(200).json({
      message: "Emergency stop update failed",
      botId,
      enabled: Boolean(enabled),
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
