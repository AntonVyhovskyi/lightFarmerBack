import { ATR, EMA } from "technicalindicators";
import { ActionsTypes } from "../../execution/types";
import { ParamsTypeForConservativeStrategy } from "./types";


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

export const getActionsFromConservativeEmaStrategy = (options: ParamsTypeForConservativeStrategy): ActionsTypes[] => {
    let actions: ActionsTypes[] = [];
    const { emaShortPeriod,
        emaLongPeriod,
        atrPeriod,
        atrRange,
        riskPct,
        atrPctforSL,
        trailStartFromParams,
        trailGapFromParams,
        bePrc,
        balance,
        candles,
        position,
        symbol,
        orders,
        leverage
    } = options;

    const closes = candles.map(c => parseFloat(c[4]));
    const highs = candles.map(c => parseFloat(c[2]));
    const lows = candles.map(c => parseFloat(c[3]));

    const emaShortValues = EMA.calculate({ values: closes, period: emaShortPeriod });
    const emaLongValues = EMA.calculate({ values: closes, period: emaLongPeriod });
    const atrValues = ATR.calculate({ close: closes, high: highs, low: lows, period: atrPeriod });

    const emaShort = emaShortValues[emaShortValues.length - 1];
    const emaLong = emaLongValues[emaLongValues.length - 1];

    const prevEmaShort = emaShortValues[emaShortValues.length - 2];
    const prevEmaLong = emaLongValues[emaLongValues.length - 2];

    const atr = atrValues[atrValues.length - 1];

    const price = closes[closes.length - 1];
    const prePrice = closes[closes.length - 2];


    // ________________________________BUY SELL FUNCTIONS_________________________________________
    // 
    // ____________________________________________________________________________________________


    const openBuyOrder = async (slPrice: number) => {


        const { qty, nMargin, notional } = calculateQtyAndNMargin(balance.total, riskPct, price, slPrice, leverage, "long");

        if (nMargin > balance.total) {
            console.log(`⛔ Not enough balance to open long position. Required margin: ${nMargin}, Available balance: ${balance.total}`);
            const newLeverage = Math.ceil(notional / balance.total);

            if (newLeverage > 20) {
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

        if (position < 0) {
            actions.push({ type: 'closePosition', options: { marketIndex: symbol.index, quantity: Math.abs(position), size: false, price: price } });
        }


        actions.push({ type: 'openPosition', options: { marketIndex: symbol.index, quantity: qty, size: true, price: price, slPrice: slPrice } });

    }

    return actions;

}