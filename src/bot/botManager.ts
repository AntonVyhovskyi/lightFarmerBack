import { getCandlesFromBinance } from "../services/binanceApiFolder/getCandles";
import { subscribeBinanceCandlesWS } from "../services/binanceWebSocketsFolder/candleWS";
import { subscribeToAccountOrdersWS } from "../services/lighterWebSocketsFolder/accountOrdersWS";
import { subscribeToAccountAllWS } from "../services/lighterWebSocketsFolder/accountAllWS";
import { OrderType, StartOptionsType } from "./types";
import { subscribeToAccountStatsWS } from "../services/lighterWebSocketsFolder/accountStatsWS";
import { excutor } from "./execution/executor";
import { botEngine } from "./botEngine";
import { getActionsFromConservativeEmaStrategy } from "./strategies/conservativeEma/conservativeEmaStrategy";
import { startEventLoopLagMonitor } from "./strategies/tools/testEventLoop";


export class BotManager {
    private bots = new Map<string, { stop: () => Promise<void> }>();

    async start(options: StartOptionsType) {
        if(this.bots.size > 0) {
            console.log("A bot is already running. Only one bot can be run at a time.");
            throw new Error("A bot is already running. Only one bot can be run at a time.");
        }
        startEventLoopLagMonitor();
        const botId = `${options.symbol.name}-${options.timeframe}`;
        if (this.bots.has(botId)) return botId;
        let candles: string[][] = [];
        if (candles.length === 0) {
            candles = await getCandlesFromBinance(options.symbol.name, options.timeframe, 500);
        }
        let orders: OrderType[] = [];
        let position: number = 0;
        let balance: { total: number; avaliable: number } = { total: 0, avaliable: 0 };
        let currentLeverage: number = 0;
        let trailingActive: boolean = false;
        let beActive: boolean = false;
        let entryPrice: string = "0";

        // change leverage on start --------------------------------------------------------------------------
        try {
            await excutor([{ type: 'updateLeverage', options: { marketIndex: options.symbol.index, leverage: options.leverage } }]);
            currentLeverage = options.leverage;
        } catch (error) {
            console.error("Error executing leverage change on bot start:", error);
        }


        // ---------------------------------------------------------------------------------------------------




        const accountWS = subscribeToAccountAllWS(Number(process.env.ACCOUNT_INDEX!), (data) => {

            const key = String(options.symbol.index); // '2'
            if (data.positions?.[key]) {
                position = data.positions?.[key]?.position || 0;
                if (data.positions?.[key]?.sign < 0) {
                    position = -data.positions?.[key]?.position || 0;
                }
            }

            entryPrice = data.positions?.[key]?.avg_entry_price || 0;






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




        const candlesWS = subscribeBinanceCandlesWS(options.symbol.name, options.timeframe, async (candle) => {
            console.log("--------=======-----------===========-------------");


            candles.push(candle);
            if (candles.length > 500) {
                candles.shift();
            }
            if (accountWS.readyState !== 1 || ordersWS.readyState !== 1 || accountStatsWS.readyState !== 1) {
                console.log("One of the WS is not open yet. Skipping candle processing.");
                return;
            }
            const actions = await botEngine({ ...options, candles, position: Number(position), orders, balance, leverage: currentLeverage, optLeverage: options.leverage, beActive, trailingActive, entryPrice }, getActionsFromConservativeEmaStrategy);
            for (const action of actions) {
                if (action.type === 'updateLeverage' && action.options.leverage !== currentLeverage) {
                    currentLeverage = action.options.leverage;
                }
                if (action.type === 'trailingActive') trailingActive = action.options.isActive;
                if (action.type === 'beActive') beActive = action.options.isActive; 
            }
        })

        this.bots.set(botId, {
            stop: async () => {
                candlesWS.close();
                accountStatsWS.close();
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