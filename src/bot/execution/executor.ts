import { changeLeverage } from "../../services/lighterSdkFolder/changeLeverage";
import { closePosition } from "../../services/lighterSdkFolder/closePosition";
import { openOrder } from "../../services/lighterSdkFolder/openOrder";
import { updateOrder } from "../../services/lighterSdkFolder/updateOrder";
import { ActionsTypes } from "./types";

export const excutor = async (actions: ActionsTypes[]) => {
    actions.forEach(async (action: ActionsTypes) => {
        console.log(action.type, action.options);

        if (action.type === 'updateLeverage') {
            await changeLeverage(action.options.marketIndex, action.options.leverage);
        } else if (action.type === 'closePosition') {
            await closePosition(action.options.marketIndex, action.options.quantity, action.options.size, Number(action.options.price));
        } else if (action.type === 'openPosition') {
            await openOrder(action.options.marketIndex, action.options.size, action.options.quantity, Number(action.options.price), Number(action.options.slPrice));
        } else if (action.type === 'updateOrder') {
            updateOrder(action.options.marketIndex, action.options.orderIndex, action.options.baseAmount, action.options.price, action.options.triggerPrice);
        }
    });
}