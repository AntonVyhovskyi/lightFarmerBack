
import { subscribeBinanceCandlesWS } from "../services/binanceWebSocketsFolder/candleWS";
import { subscribeToAccountOrdersWS } from "../services/lighterWebSocketsFolder/accountOrdersWS";
import { subscribeToAccountAllWS } from "../services/lighterWebSocketsFolder/accountAllWS";
import { OrderType, startTrailingOptionsType } from "./types";

import { trailingBotEngine } from "./botEngine";

import { getActionsFromStopLossTrailing } from "./strategies/stopLossTrailing/stopLossTrailing";


export class TrailingBotManager {
    private bots = new Map<string, { stop: () => Promise<void> }>();

    async start(options: startTrailingOptionsType)  {
        
        
        const botId = `${options.symbol.name}-${options.timeframe}`;
        if (this.bots.has(botId)) return botId;
        
        let orders: OrderType[] = [];
        let position: number = 0;
        
      




        const accountWS = await subscribeToAccountAllWS(Number(process.env.ACCOUNT_INDEX!), (data) => {

            const key = String(options.symbol.index); // '2'
            if (data.positions?.[key]) {
                position = data.positions?.[key]?.position || 0;
                if (data.positions?.[key]?.sign < 0) {
                    position = -data.positions?.[key]?.position || 0;
                }
            }

          






        }, (error) => {
            console.error("Account WS error:", error);
        })


        const ordersWS = await subscribeToAccountOrdersWS(Number(process.env.ACCOUNT_INDEX!), options.symbol.index, (data) => {
            const key = String(options.symbol.index); // '2'
            if (data.orders?.[key]) {
                orders = data.orders?.[key] || [];
            }
            ;


        }, (error) => {
            console.error("Orders WS error:", error);
        });

   




        const candlesWS = subscribeBinanceCandlesWS(options.symbol.name, options.timeframe, async (candle) => {
            console.log("--------=======-----------===========-------------");


         
            await trailingBotEngine({ ...options, candle, position: Number(position), orders}, getActionsFromStopLossTrailing);
             
            
        })

        this.bots.set(botId, {
            stop: async () => {
                candlesWS.close();
             
                ordersWS.close();
                accountWS.close();
                this.bots.delete(botId);
            }
        });
        return botId;

    }

    

    async stop(botId: string) {
        const bot = this.bots.get(botId);
        if (bot) {
            await bot.stop();

        } else {
            throw new Error(`Bot with ID ${botId} not found.`);
        }
    }

    async getBots() {
        return Array.from(this.bots.keys());
    }
}

// const botManager = new BotManager();
// botManager.start({
//     emaShortPeriod: 3,
//     emaLongPeriod: 10,
//     atrPeriod: 14,
//     atrRange: 0.01,
//     riskPct: 0.5,
//     atrPctforSL: 2.5,
//     trailStartFromParams: 0.2,
//     trailGapFromParams: 0.1,
//     leverage: 10,
//     bePrc: 0.1,
//     timeframe: "1m",
//     symbol: { name: "SOL", index: 2 },
//     strategyFunc: getActionsFromConservativeEmaStrategy
// });