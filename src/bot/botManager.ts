import { getCandlesFromBinance } from "../services/binanceApiFolder/getCandles";
import { subscribeBinanceCandlesWS } from "../services/binanceWebSocketsFolder/candleWS";
import { subscribeToAccountOrdersWS } from "../services/lighterWebSocketsFolder/accountOrdersWS";
import { subscribeToAccountAllWS } from "../services/lighterWebSocketsFolder/accountAllWS";
import { OrderType, StartOptionsType } from "./types";
import dotenv from 'dotenv';
import { subscribeToAccountStatsWS } from "../services/lighterWebSocketsFolder/accountStatsWS";
import { excutor } from "./execution/executor";
import { botEngine } from "./botEngine";
import { getActionsFromConservativeEmaStrategy } from "./strategies/conservativeEma/conservativeEmaStrategy";

dotenv.config();

export class BotManager {
    private bots = new Map<string, { stop: () => Promise<void> }>();

    async start(options: StartOptionsType) {
        const botId = `${options.symbol.name}-${options.timeframe}`;
        if (this.bots.has(botId)) return botId;
        let candles: string[][] = [];
        // if (candles.length === 0) {
        //     candles = await getCandlesFromBinance(options.symbol.name, options.timeframe, 500);
        // }
        let orders: OrderType[] = [];
        let position: number = 0;
        let balance: { total: number; avaliable: number } = { total: 0, avaliable: 0 };
        let leverage: number = 0;

        // change leverage on start --------------------------------------------------------------------------
        try {
           await excutor([{ type: 'updateLeverage', options: { marketIndex: options.symbol.index, leverage: options.leverage } }]);
           leverage = options.leverage;
        } catch (error) {
            console.error("Error executing leverage change on bot start:", error);
        }


        // ---------------------------------------------------------------------------------------------------


        const candlesWS = subscribeBinanceCandlesWS(options.symbol.name, options.timeframe, (candle) => {

            candles.push(candle);
            if (candles.length > 500) {
                candles.shift();
            }
            botEngine({...options, candles, position, orders, balance, leverage}, );
        })


        const accountWS = subscribeToAccountAllWS(Number(process.env.ACCOUNT_INDEX!), (data) => {

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

        const accountStatsWS = subscribeToAccountStatsWS(Number(process.env.ACCOUNT_INDEX!), (data) => {
            if (data.stats?.available_balance !== undefined) {
                balance = {
                    total: Number(data.stats.portfolio_value || "0"),
                    avaliable: Number(data.stats.available_balance || "0"),
                };

            }
            


        }, (error) => {
            console.error("Account Stats WS error:", error);
        });

        this.bots.set(botId, {
            stop: async () => {
                candlesWS.close();
                accountStatsWS.close();
                ordersWS.close();
                accountWS.close();
                this.bots.delete(botId);
            }
        });

    }
}

const botManager = new BotManager();
botManager.start({
    emaShortPeriod: 20,
    emaLongPeriod: 50,
    atrPeriod: 14,
    atrRange: 14,
    riskPct: 1,
    atrPctforSL: 1.5,
    trailStartFromParams: 2,
    trailGapFromParams: 1,
    leverage: 10,
    bePrc: 0.5,
    timeframe: "1m",
    symbol: { name: "SOL", index: 2 },
    strategyFunc: getActionsFromConservativeEmaStrategy
});