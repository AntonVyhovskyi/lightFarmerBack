import { log } from "node:console";
import { ActionsTypes } from "../../execution/types";
import { normalizePrice } from "../tools/normalizePrice";
import { normalizeQty } from "../tools/normalizeQty";
import { ParamsTypeForStopLossTrailing } from "./types";
















export const getActionsFromStopLossTrailing = (
    params: ParamsTypeForStopLossTrailing
): ActionsTypes[] => {

    const { trailingGapFromParams, position, symbol, orders } = params;
   


    const slOrder = orders.find(order => order.type === 'stop-loss');
    const slPrice = slOrder ? parseFloat(slOrder.trigger_price) : 0;
    const slIndex = slOrder ? slOrder.order_index : 0;
console.log("slOrder:", slOrder);

    const price = parseFloat(params.candle[4]);

    const newSL = position > 0 ? price - (price * trailingGapFromParams/100) : price + (price * trailingGapFromParams/100);
    

    if (position > 0 && newSL > slPrice) {
        log(`update sl from ${slPrice} to ${newSL}`);
        return [{
            type: 'updateOrder',
            options: {
                marketIndex: symbol.index,
                orderIndex: slIndex,
                baseAmount: 0,
                price:  normalizePrice(newSL - newSL * 0.01, symbol.index),
                triggerPrice: normalizePrice(newSL, symbol.index),
            }
        }];
    } else if (position < 0 && newSL < slPrice) {
        console.log(`update sl from ${slPrice} to ${newSL}`);
        
        return [
            {
                type: 'updateOrder',
                options: {
                    marketIndex: symbol.index,
                    orderIndex: slIndex,
                    baseAmount: 0,
                    price: normalizePrice(newSL + newSL * 0.01, symbol.index),
                    triggerPrice: normalizePrice(newSL, symbol.index),
                }
            }
        ];
    } else {
        log(`no sl update. position: ${position}, newSL: ${newSL}, current SL: ${slPrice}`);
        return [];
    }




}