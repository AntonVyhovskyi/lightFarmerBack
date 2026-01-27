
import { Request, Response } from "express";
import { BotManager } from "../bot/botManager";
import { StartOptionsType } from "../bot/types";
import { getActionsFromConservativeEmaStrategy } from "../bot/strategies/conservativeEma/conservativeEmaStrategy";



const botManager = new BotManager();



export const startBotController = async (req: Request, res: Response) => {
    const options: StartOptionsType = req.body;
    try {
        const botId = await botManager.start({...options, strategyFunc: getActionsFromConservativeEmaStrategy});
        return res.status(200).json({ botId });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to start bot', details: error });
    }
    
    
}


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