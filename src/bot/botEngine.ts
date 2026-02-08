import { excutor } from "./execution/executor";
import { ActionsTypes } from "./execution/types";
import { ParamsTypeForStopLossTrailing } from "./strategies/stopLossTrailing/types";

import { ParamsForSomeStrategy } from "./strategies/types";
import { OptionsForEngine } from "./types";



export const botEngine = (options: OptionsForEngine, getActions: (params: ParamsForSomeStrategy ) => ActionsTypes[]) => {
    const actions = getActions(options);
    
    excutor(actions);

    return actions;

}

export const trailingBotEngine = (options: ParamsTypeForStopLossTrailing, getActions: (params: ParamsTypeForStopLossTrailing ) => ActionsTypes[]) => {
    const actions = getActions(options);
    
    excutor(actions);

    return actions;

}