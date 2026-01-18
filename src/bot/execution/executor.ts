import { changeLeverage } from "../../services/lighterSdkFolder/changeLeverage";
import { closePosition } from "../../services/lighterSdkFolder/closePosition";
import { openOrder } from "../../services/lighterSdkFolder/openOrder";
import { ActionsTypes } from "./types";

export const excutor = async (actions: ActionsTypes[]) => {
    actions.forEach((action:any) => {
        if (action.type === 'updateLeverage') {
            changeLeverage(action.options.marketIndex, action.options.leverage);
        } else if (action.type === 'closePosition') {
          closePosition(action.options.marketIndex, action.options.quantity, action.options.size, action.options.price);
        } else if (action.type === 'openPosition') {
          openOrder(action.options.marketIndex, action.options.size, action.options.quantity, action.options.price, action.options.slPrice);
        }
    });
}