import { ActionsTypes } from "./execution/types";
import { getActionsFromConservativeEmaStrategy } from "./strategies/conservativeEma/conservativeEmaStrategy";
import { ParamsForSomeStrategy } from "./strategies/types";
import { OptionsForEngine } from "./types";



export const botEngine = (options: OptionsForEngine, getActions: (params: ParamsForSomeStrategy) => ActionsTypes[]) => {
    const actions = getActions(options);

    return actions;

}