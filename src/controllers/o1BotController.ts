import { Request, Response } from "express";
import { O1BotManager } from "../bot/exchanges/o1/manager";

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
  const { botId } = req.body as { botId?: string };
  if (!botId) return res.status(400).json({ error: "botId is required" });
  try {
    await o1BotManager.stop(botId);
    return res.status(200).json({ message: "O1 bot stopped" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to stop O1 bot", details: serializeError(err) });
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
    const diagnostics = o1BotManager.getDiagnostics(botId);
    return res.status(200).json({ enabled, diagnostics });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch O1 diagnostics", details: serializeError(err) });
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
    return res.status(200).json({ message: "Emergency stop updated", botId, enabled: Boolean(enabled) });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update emergency stop", details: serializeError(err) });
  }
};
