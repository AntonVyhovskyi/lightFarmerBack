import { Request, Response } from "express";
import { TrailingBotManager } from "../bot/trailingBotManager";
import { startTrailingOptionsType } from "../bot/types";
import { getActionsFromStopLossTrailing } from "../bot/strategies/stopLossTrailing/stopLossTrailing";

const trailingBotManager = new TrailingBotManager();


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


export const startTrailingBotController = async (req: Request, res: Response) => {
    const options: startTrailingOptionsType = req.body;
    const trailingGapFromParams = parseFloat(options.trailingGapFromParams as unknown as string);

    const requireFields: (keyof startTrailingOptionsType)[] = [
        'symbol',
        'timeframe',
        "trailingGapFromParams"

    ];
    const missing = requireFields.filter(key => {
        return options[key] === undefined || options[key] === null;
    })
    if (missing.length > 0) {
        return res.status(400).json({ error: "Missing required parameters", missing });
    }
    try {
        const botId = await trailingBotManager.start({
            ...options,
            trailingGapFromParams,
            strategyFunc: getActionsFromStopLossTrailing,
        });

        return res.status(200).json({ botId });
    } catch (err) {
        console.error("Failed to start bot:", err);
        return res.status(500).json({
            error: "Failed to start bot",
            details: serializeError(err),
        });
    }
}


export const stopTrailingBotController = async (req: Request, res: Response) => {
    const { botId } = req.body;
    try {
        await trailingBotManager.stop(botId);
        return res.status(200).json({ message: 'Bot stopped successfully' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to stop bot', details: serializeError(error) });
    }
}


export const getTrailingBotsController = async (req: Request, res: Response) => {
    try {
        const bots = await trailingBotManager.getBots();
        return res.status(200).json({ bots });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to get bots', details: serializeError(error) });
    }
}