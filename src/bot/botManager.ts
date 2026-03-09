import { getCandlesFromBinance } from "../services/binanceApiFolder/getCandles";
import { subscribeBinanceCandlesWS } from "../services/binanceWebSocketsFolder/candleWS";
import { subscribeToAccountOrdersWS } from "../services/lighterWebSocketsFolder/accountOrdersWS";
import { subscribeToAccountAllWS } from "../services/lighterWebSocketsFolder/accountAllWS";
import { OrderType, StartOptionsType, startTrailingOptionsType } from "./types";
import { subscribeToAccountStatsWS } from "../services/lighterWebSocketsFolder/accountStatsWS";
import { excutor } from "./execution/executor";
import { botEngine } from "./botEngine";
import { getActionsFromConservativeEmaStrategy } from "./strategies/conservativeEma/conservativeEmaStrategy";
import { startEventLoopLagMonitor } from "./strategies/tools/testEventLoop";


const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type WSCache = {
    candles: string[][];
    orders: OrderType[];
    position: number;
    balance: { total: number; avaliable: number };
    currentLeverage: number;
    trailingActive: boolean;
    beActive: boolean;
    entryPrice: string;
};

export class BotManager {
    private bots = new Map<string, { stop: () => Promise<void>; restartIntervalId?: NodeJS.Timeout; cache?: WSCache }>();

    async start(options: StartOptionsType ) {
        if(this.bots.size > 0) {
            console.log("A bot is already running. Only one bot can be run at a time.");
            throw new Error("A bot is already running. Only one bot can be run at a time.");
        }
        startEventLoopLagMonitor();
        const botId = `${options.symbol.name}-${options.timeframe}`;
        if (this.bots.has(botId)) return botId;

        const cache: WSCache = {
            candles: [],
            orders: [],
            position: 0,
            balance: { total: 0, avaliable: 0 },
            currentLeverage: 0,
            trailingActive: false,
            beActive: false,
            entryPrice: "0",
        };
        if (cache.candles.length === 0) {
            cache.candles = await getCandlesFromBinance(options.symbol.name, options.timeframe, 500);
        }

        // change leverage on start --------------------------------------------------------------------------
        try {
            await excutor([{ type: 'updateLeverage', options: { marketIndex: options.symbol.index, leverage: options.leverage } }]);
            cache.currentLeverage = options.leverage;
        } catch (error) {
            console.error("Error executing leverage change on bot start:", error);
        }


        // ---------------------------------------------------------------------------------------------------




        const accountWS = await subscribeToAccountAllWS(Number(process.env.ACCOUNT_INDEX!), (data) => {

            const key = String(options.symbol.index); // '2'
            if (data.positions?.[key]) {
                cache.position = data.positions?.[key]?.position || 0;
                if (data.positions?.[key]?.sign < 0) {
                    cache.position = -data.positions?.[key]?.position || 0;
                }
            }

            cache.entryPrice = data.positions?.[key]?.avg_entry_price || 0;






        }, (error) => {
            console.error("Account WS error:", error);
        })


        const ordersWS = await subscribeToAccountOrdersWS(Number(process.env.ACCOUNT_INDEX!), options.symbol.index, (data) => {
            const key = String(options.symbol.index); // '2'
            if (data.orders?.[key]) {
                cache.orders = data.orders?.[key] || [];
            }
            ;


        }, (error) => {
            console.error("Orders WS error:", error);
        });

        const accountStatsWS = await subscribeToAccountStatsWS(Number(process.env.ACCOUNT_INDEX!), (data) => {
            if (data.stats?.available_balance !== undefined) {
                cache.balance = {
                    total: Number(data.stats.portfolio_value || "0"),
                    avaliable: Number(data.stats.available_balance || "0"),
                };

            }



        }, (error) => {
            console.error("Account Stats WS error:", error);
        });




        const candlesWS = subscribeBinanceCandlesWS(options.symbol.name, options.timeframe, async (candle) => {
            console.log("--------=======-----------===========-------------");


            cache.candles.push(candle);
            if (cache.candles.length > 500) {
                cache.candles.shift();
            }
            if (accountWS.readyState !== 1 || ordersWS.readyState !== 1 || accountStatsWS.readyState !== 1) {
                console.log("One of the WS is not open yet. Skipping candle processing.");
                return;
            }
            const actions = await botEngine({ ...options, candles: cache.candles, position: Number(cache.position), orders: cache.orders, balance: cache.balance, leverage: cache.currentLeverage, optLeverage: options.leverage, beActive: cache.beActive, trailingActive: cache.trailingActive, entryPrice: cache.entryPrice }, getActionsFromConservativeEmaStrategy);
            for (const action of actions) {
                if (action.type === 'updateLeverage' && action.options.leverage !== cache.currentLeverage) {
                    cache.currentLeverage = action.options.leverage;
                }
                if (action.type === 'trailingActive') cache.trailingActive = action.options.isActive;
                if (action.type === 'beActive') cache.beActive = action.options.isActive; 
            }
        })

        const stopBot = async () => {
            candlesWS.close();
            accountStatsWS.close();
            ordersWS.close();
            accountWS.close();
            const botEntry = this.bots.get(botId);
            if (botEntry?.restartIntervalId) {
                clearInterval(botEntry.restartIntervalId);
            }
            this.bots.delete(botId);
        };

        let restartIntervalId: NodeJS.Timeout | undefined;
        if (options.withRestart) {
            restartIntervalId = setInterval(async () => {
                console.log(`[BotManager] Restarting bot ${botId} (daily restart)...`);
                await stopBot();
                console.log(`[BotManager] Waiting 10 seconds before restart...`);
                await new Promise((resolve) => setTimeout(resolve, 10_000));
                await this.start({ ...options, withRestart: true });
            }, ONE_DAY_MS);
        }

        this.bots.set(botId, {
            stop: stopBot,
            restartIntervalId,
            cache,
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

    getWSCache(botId: string): WSCache | null {
        const bot = this.bots.get(botId);
        if (!bot?.cache) return null;
        return bot.cache;
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