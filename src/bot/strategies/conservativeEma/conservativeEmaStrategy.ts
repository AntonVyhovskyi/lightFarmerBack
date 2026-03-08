import { normalizePrice } from './../tools/normalizePrice';
import { ATR, EMA, SMA } from "technicalindicators";
import { ActionsTypes } from "../../execution/types";
import { ParamsTypeForConservativeStrategy } from "./types";
import { normalizeQty } from '../tools/normalizeQty';


function calculateQtyAndNMargin(balance: number, riskPct: number, entryPrice: number, slPrice: number, leverage: number, side: "long" | "short") {
    let dPrice
    if (side === "long") {
        dPrice = entryPrice - slPrice;
    } else {
        dPrice = slPrice - entryPrice;
    }


    const maxLoss = (balance * (riskPct / 100))
    const qty = maxLoss / dPrice;
    const notional = qty * entryPrice;
    const nMargin = notional / leverage;

    return { qty, nMargin, notional };
}

const DEBUG_OPEN_POSITION = process.env.DEBUG_OPEN_POSITION === "true";

export const getActionsFromConservativeEmaStrategy = (options: ParamsTypeForConservativeStrategy): ActionsTypes[] => {
    let actions: ActionsTypes[] = [];
    const { emaShortPeriod,
        emaLongPeriod,
        atrPeriod,
        atrRange,
        atrRange2,
        atrRange3,  
        riskPct,
        riskPct2,
        riskPct3,
        atrPctforSL,
        trailStartFromParams,
        trailGapFromParams,
        bePrc,
        balance,
        candles,
        position,
        symbol,
        orders,
        leverage,
        optLeverage,
        beActive,
        trailingActive,
        entryPrice,
        averageValumesMultiple,
        timeframe
    } = options;

    const closes = candles.map(c => parseFloat(c[4]));
    const highs = candles.map(c => parseFloat(c[2]));
    const lows = candles.map(c => parseFloat(c[3]));
    const valumes = candles.map(c => parseFloat(c[5]));

    const emaShortValues = EMA.calculate({ values: closes, period: emaShortPeriod });
    const emaLongValues = EMA.calculate({ values: closes, period: emaLongPeriod });
    const atrValues = ATR.calculate({ close: closes, high: highs, low: lows, period: atrPeriod });
    const averageValumes = SMA.calculate({ values: valumes, period: 50 });

    const emaShort = emaShortValues[emaShortValues.length - 1];
    const emaLong = emaLongValues[emaLongValues.length - 1];

    const prevEmaShort = emaShortValues[emaShortValues.length - 2];
    const prevEmaLong = emaLongValues[emaLongValues.length - 2];


    const atr = atrValues[atrValues.length - 1];

    const price = closes[closes.length - 1];
    const valume = Number(candles[candles.length - 1][5]);
    const prevValume = Number(candles[candles.length - 2][5]);

    const debugOpenPositionLog = (event: string, details: Record<string, any> = {}) => {
        if (!DEBUG_OPEN_POSITION) return;

        const lastCandle = candles[candles.length - 1];
        const candleTime = lastCandle ? new Date(Number(lastCandle[0])).toISOString() : undefined;

        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            scope: "openPositionLogic",
            symbol: symbol.name,
            timeframe,
            event,
            emaShort,
            emaLong,
            prevEmaShort,
            prevEmaLong,
            price,
            candleTime,
            position,
            ...details,
        }));
    };



    // ________________________________BUY SELL FUNCTIONS_________________________________________
    // 
    // ____________________________________________________________________________________________


    const openBuyOrder = (slPrice: number, shouldRiskPct: number) => {


        const { qty, nMargin, notional } = calculateQtyAndNMargin(balance.total, shouldRiskPct, price, slPrice, leverage, "long");
        const fixedSlPrice = normalizePrice(slPrice, symbol.index);
        const fixedPrice = normalizePrice(price, symbol.index);
        if (nMargin > balance.total) {
            console.log(`⛔ Not enough balance to open long position. Required margin: ${nMargin}, Available balance: ${balance.total}`);
            const newLeverage = Math.ceil(notional / balance.total);

            if (newLeverage > 25) {
                console.log('За велика позиція для данного ризик менеджменту');
                return [] as ActionsTypes[];
            }

            actions.push({ type: 'updateLeverage', options: { marketIndex: symbol.index, leverage: newLeverage } });

            const newMargin = notional / newLeverage;
            if (newMargin > balance.total) {
                console.log("❌ Even with new leverage margin still too high");
                return [] as ActionsTypes[];
            }
        }
        const fixedSlQty = normalizeQty(qty, symbol.index);
        if (position < 0) {
            actions.push({ type: 'closePosition', options: { marketIndex: symbol.index, quantity: Math.abs(position), size: false, price: fixedPrice } });
        }


        actions.push({ type: 'openPosition', options: { marketIndex: symbol.index, quantity: fixedSlQty, size: true, price: fixedPrice, slTrigerPrice: fixedSlPrice, slPrice: normalizePrice(slPrice - slPrice * 0.1, symbol.index) } });

    }


    const openSellOrder = async (slPrice: number, shouldRiskPct: number) => {
        const { qty, nMargin, notional } = calculateQtyAndNMargin(balance.total, shouldRiskPct, price, slPrice, leverage, "short");
        const fixedSlPrice = normalizePrice(slPrice, symbol.index);
        const fixedPrice = normalizePrice(price, symbol.index);

        if (nMargin > balance.total) {
            console.log(`⛔ Not enough balance to open short position. Required margin: ${nMargin}, Available balance: ${balance.total}`);
            const newLeverage = Math.ceil(notional / balance.total);
            if (newLeverage > 25) {
                console.log('За велика позиція для данного ризик менеджменту');
                return [];
            }
            actions.push({ type: 'updateLeverage', options: { marketIndex: symbol.index, leverage: newLeverage } });

            const newMargin = notional / newLeverage;
            if (newMargin > balance.total) {
                console.log("❌ Even with new leverage margin still too high");
                return [];
            }
        }
        const fixedSlQty = normalizeQty(qty, symbol.index);

        if (position > 0) {
            actions.push({ type: 'closePosition', options: { marketIndex: symbol.index, quantity: Math.abs(position), size: true, price: fixedPrice } });
        }
        actions.push({ type: 'openPosition', options: { marketIndex: symbol.index, quantity: fixedSlQty, size: false, price: price, slTrigerPrice: fixedSlPrice, slPrice: normalizePrice(slPrice + slPrice * 0.1, symbol.index) } });
    }



    // _____________________________________________________________________________________________
    // _____________________________________________________________________________________________
    // _____________________________________________________________________________________________



    // ______________________________OPEN POSITION LOGIC_________________________________________




    const openPositionLogic = () => {
        if (position !== 0) {
            debugOpenPositionLog("позиція_вже_відкрита", { position });
            return;
        }

        if (leverage !== optLeverage) {
            actions.push({ type: 'updateLeverage', options: { marketIndex: symbol.index, leverage: optLeverage } });
            debugOpenPositionLog("оновлення_плеча", { поточнеПлече: leverage, цільовеПлече: optLeverage });
        }
        if (beActive) {
            actions.push({ type: 'beActive', options: { isActive: false } });
            debugOpenPositionLog("скидання_be");
        }
        if (trailingActive) {
            actions.push({ type: 'trailingActive', options: { isActive: false } });
            debugOpenPositionLog("скидання_трейлінгу");
        }

        if (emaShort > emaLong && prevEmaShort < prevEmaLong) {
            const lastFiveClothes = candles.slice(-5).map(c => parseFloat(c[4]));
            const minLastFive = Math.min(...lastFiveClothes);
            const priceChangePct = ((closes[closes.length - 1] - minLastFive) / minLastFive) * 100;

            debugOpenPositionLog("перетин_ема_лонг", { priceChangePct, atrRange });

            if (priceChangePct >= atrRange) {
                const avgVolume = averageValumes[averageValumes.length - 1];
                const mustBeVolume = avgVolume * Number(averageValumesMultiple);
                if (mustBeVolume < valume || mustBeVolume < prevValume) {
                    debugOpenPositionLog("слабкий_обʼєм_лонг", {
                        valume,
                        prevValume,
                        avgVolume,
                        mustBeVolume,
                    });
                }
                const shouldRiskPct = priceChangePct >= atrRange3 ? riskPct3 : priceChangePct >= atrRange2 ? riskPct2 : riskPct;
                const slPrice = closes[closes.length - 1] - atr * (atrPctforSL);
                debugOpenPositionLog("сигнал_на_відкриття_лонг", { shouldRiskPct, slPrice });
                openBuyOrder(slPrice, shouldRiskPct);
            } else {
                debugOpenPositionLog("слабкий_рух_для_лонг", { atrRange, priceChangePct });
            }
        } else if (emaShort < emaLong && prevEmaShort > prevEmaLong) {
            const lastFiveClothes = candles.slice(-5).map(c => parseFloat(c[4]));
            const maxLastFive = Math.max(...lastFiveClothes);
            const priceChangePct = ((maxLastFive - closes[closes.length - 1]) / maxLastFive) * 100;

            debugOpenPositionLog("перетин_ема_шорт", { priceChangePct, atrRange });

            if (priceChangePct >= atrRange) {
                const avgVolume = averageValumes[averageValumes.length - 1];
                const mustBeVolume = avgVolume * Number(averageValumesMultiple);
                if (mustBeVolume < valume || mustBeVolume < prevValume) {
                    debugOpenPositionLog("слабкий_обʼєм_шорт", {
                        valume,
                        prevValume,
                        avgVolume,
                        mustBeVolume,
                    });
                }
                const shouldRiskPct = priceChangePct >= atrRange3 ? riskPct3 : priceChangePct >= atrRange2 ? riskPct2 : riskPct;
                const slPrice = closes[closes.length - 1] + atr * (atrPctforSL);
                debugOpenPositionLog("сигнал_на_відкриття_шорт", { shouldRiskPct, slPrice });
                openSellOrder(slPrice, shouldRiskPct);
            } else {
                debugOpenPositionLog("слабкий_рух_для_шорт", { atrRange, priceChangePct });
            }
        } else {
            debugOpenPositionLog("нема_перетину_ема");
        }
    }

    openPositionLogic();
    // _____________________________________________________________________________________________
    // _____________________________________________________________________________________________
    // _____________________________________________________________________________________________

    // -------------------- IF LONG ------------------------


    let slOrder = orders.find(order => order.type === 'stop-loss');
    let slPrice = slOrder ? parseFloat(slOrder.trigger_price) : 0;
    let slIndex = slOrder ? slOrder.order_index : 0;


    if (position > 0) {
        if (!beActive && !trailingActive && price >= Number(entryPrice) * (1 + bePrc / 100) && price < Number(entryPrice) * (1 + trailStartFromParams / 100)) {

            actions.push({ type: 'beActive', options: { isActive: true } });

            actions.push({
                type: 'updateOrder',
                options: {
                    marketIndex: symbol.index,
                    orderIndex: slIndex,
                    baseAmount: normalizeQty(position, symbol.index),
                    price: normalizePrice((Number(entryPrice) - Number(entryPrice) * 0.1), symbol.index),
                    triggerPrice: normalizePrice(entryPrice, symbol.index)
                }
            });
        } else if (!trailingActive && price >= Number(entryPrice) * (1 + trailStartFromParams / 100)) {
            const newPriceForSL = price - (price * (trailGapFromParams / 100));

            actions.push({ type: 'trailingActive', options: { isActive: true } });
            actions.push({
                type: 'updateOrder',
                options: {
                    marketIndex: symbol.index,
                    orderIndex: slIndex,
                    baseAmount: normalizeQty(position, symbol.index),
                    price: normalizePrice(newPriceForSL - newPriceForSL * 0.1, symbol.index),
                    triggerPrice: normalizePrice(newPriceForSL, symbol.index),

                }
            });
        } else if (trailingActive) {
            const newPriceForSL = price - (price * (trailGapFromParams / 100));
            console.log({ price, newPriceForSL });

            if (newPriceForSL > slPrice) {
                actions.push({
                    type: 'updateOrder',
                    options: {
                        marketIndex: symbol.index,
                        orderIndex: slIndex,
                        baseAmount: normalizeQty(position, symbol.index),
                        price: normalizePrice(newPriceForSL - newPriceForSL * 0.1, symbol.index),
                        triggerPrice: normalizePrice(newPriceForSL, symbol.index)
                    }
                });
            } else {
                console.log(`Позиція Відкрита: ${position}`);
                console.log(`Дія не виконана`);
                console.log(`Новий стоп лосс ${newPriceForSL} менший за поточний ${slPrice}`);
            }

        } else {
            console.log(`Позиція Відкрита: ${position}`);
            console.log(`Дія не виконана`);
            console.log(`Безубиток ${beActive ? 'активний' : ' не активний'}`);
            console.log(`трейлінг ${trailingActive ? 'активний' : ' не активний'}`);
            console.log(`ціна ${price}`);
            console.log(`ціна для безубитку  ${position > 0 ? Number(entryPrice) * (1 + bePrc / 100) : Number(entryPrice) * (1 - bePrc / 100)}`);
            console.log(`ціна для старту трейлінгу  ${position > 0 ? Number(entryPrice) * (1 + trailStartFromParams / 100) : Number(entryPrice) * (1 - trailStartFromParams / 100)}`);



        }
    }


    // -------------------- IF SHORT ------------------------
    else if (position < 0) {
        if (!beActive && !trailingActive && price <= Number(entryPrice) * (1 - bePrc / 100) && price > Number(entryPrice) * (1 - trailStartFromParams / 100)) {
            actions.push({ type: 'beActive', options: { isActive: true } });

            actions.push({
                type: 'updateOrder',
                options: {
                    marketIndex: symbol.index,
                    orderIndex: slIndex,
                    baseAmount: normalizeQty(Math.abs(position), symbol.index),
                    price: normalizePrice((Number(entryPrice) + Number(entryPrice) * 0.1), symbol.index),
                    triggerPrice: normalizePrice(entryPrice, symbol.index)
                }
            });
        } else if (!trailingActive && price <= Number(entryPrice) * (1 - trailStartFromParams / 100)) {
            const newPriceForSL = price + (price * (trailGapFromParams / 100));
            actions.push({ type: 'trailingActive', options: { isActive: true } });
            actions.push({
                type: 'updateOrder',
                options: {
                    marketIndex: symbol.index,
                    orderIndex: slIndex,
                    baseAmount: normalizeQty(Math.abs(position), symbol.index),
                    price: normalizePrice(newPriceForSL + newPriceForSL * 0.1, symbol.index),
                    triggerPrice: normalizePrice(newPriceForSL, symbol.index)
                }
            });
        } else if (trailingActive) {
            const newPriceForSL = price + (price * (trailGapFromParams / 100));
            if (newPriceForSL < slPrice) {
                actions.push({
                    type: 'updateOrder',
                    options: {
                        marketIndex: symbol.index,
                        orderIndex: slIndex,
                        baseAmount: normalizeQty(Math.abs(position), symbol.index),
                        price: normalizePrice(newPriceForSL + newPriceForSL * 0.1, symbol.index),
                        triggerPrice: normalizePrice(newPriceForSL, symbol.index)
                    }
                });
            } else {
                console.log(`Позиція Відкрита: ${position}`);
                console.log(`Дія не виконана`);
                console.log(`Новий стоп лосс ${newPriceForSL} більший за поточний ${slPrice}`);
            }

        } else {
            console.log(`Позиція Відкрита: ${position}`);
            console.log(`Дія не виконана`);
            console.log(`Безубиток ${beActive ? 'активний' : ' не активний'}`);
            console.log(`трейлінг ${trailingActive ? 'активний' : ' не активний'}`);
            console.log(`ціна ${price}`);
            console.log(`ціна для безубитку  ${position > 0 ? Number(entryPrice) * (1 + bePrc / 100) : Number(entryPrice) * (1 - bePrc / 100)}`);
            console.log(`ціна для старту трейлінгу  ${position > 0 ? Number(entryPrice) * (1 + bePrc / 100) : Number(entryPrice) * (1 - bePrc / 100)}`);



        }


    }
    return actions;
}