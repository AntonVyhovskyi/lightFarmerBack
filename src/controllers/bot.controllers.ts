
import { Request, Response } from "express";
import { BotManager } from "../bot/botManager";
import { StartOptionsType } from "../bot/types";
import { getActionsFromConservativeEmaStrategy } from "../bot/strategies/conservativeEma/conservativeEmaStrategy";



const botManager = new BotManager();



const serializeError = (err: unknown) => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  // якщо кидають не Error, а строку/обʼєкт
  return { value: err };
};

export const startBotController = async (req: Request, res: Response) => {
  const options: StartOptionsType = req.body;
 
  
  const requireFields: (keyof StartOptionsType)[] = [
    'symbol',
    'timeframe',
    'leverage',
    'emaShortPeriod',
    'emaLongPeriod',
    'atrPeriod',
    'atrRange',
    'atrRange2',
    'atrRange3',
    'riskPct',
    'riskPct2',
    'riskPct3',
    'atrPctforSL',
    'trailStartFromParams',
    'trailGapFromParams',
    'bePrc',
    'averageValumesMultiple'
  ];
  const missing = requireFields.filter (key=>{
    return options[key] === undefined || options[key] === null;
  })
  if (missing.length > 0) {
    return res.status(400).json({ error: "Missing required parameters", missing });
  }
  try {
    const botId = await botManager.start({
       ...options,
      strategyFunc: getActionsFromConservativeEmaStrategy,
    });

    return res.status(200).json({ botId });
  } catch (err) {
    console.error("Failed to start bot:", err);
    return res.status(500).json({
      error: "Failed to start bot",
      details: serializeError(err),
    });
  }
};


export const stopBotController = async (req: Request, res: Response) => {
    const { botId } = req.body;
    try {
        await botManager.stop(botId);
        return res.status(200).json({ message: 'Bot stopped successfully' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to stop bot', details: error });
    }
}

export const getBotsController = async (req: Request, res: Response) => {
    try {
        const bots = await botManager.getBots();
        return res.status(200).json({ bots });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to get bots', details: error });
    }
}

export const getWSCacheController = async (req: Request, res: Response) => {
    const botId = typeof req.params.botId === 'string' ? req.params.botId : req.params.botId?.[0];
    if (!botId) {
        return res.status(400).json({ error: 'botId is required' });
    }
    try {
        const cache = botManager.getWSCache(botId);
        if (!cache) {
            return res.status(404).json({ error: 'Bot not found or cache not available', botId });
        }
        return res.status(200).json({ cache });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to get WS cache', details: error });
    }
}