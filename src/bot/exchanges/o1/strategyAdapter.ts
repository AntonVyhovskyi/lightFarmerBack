import { EMA } from "technicalindicators";
import type { O1State } from "./types";

export type O1StrategySignal =
  | { type: "none" }
  | { type: "openLong"; size: number }
  | { type: "openShort"; size: number }
  | { type: "closePosition" };

export type O1StrategyInput = {
  state: O1State;
  riskPct: number;
  maxPositionSize: number;
};

export const getO1ConservativeEmaSignal = ({ state, riskPct, maxPositionSize }: O1StrategyInput): O1StrategySignal => {
  if (state.candles.length < 120) return { type: "none" };
  const closes = state.candles.map((c) => Number(c[4]));
  const fast = EMA.calculate({ values: closes, period: 20 });
  const slow = EMA.calculate({ values: closes, period: 30 });
  if (fast.length < 2 || slow.length < 2) return { type: "none" };

  const prevFast = fast[fast.length - 2];
  const prevSlow = slow[slow.length - 2];
  const nowFast = fast[fast.length - 1];
  const nowSlow = slow[slow.length - 1];

  const quoteRisk = Math.max(1, state.balanceTotal * (riskPct / 100));
  const price = Number(state.candles[state.candles.length - 1][4]);
  const size = Math.min(maxPositionSize, quoteRisk / price);

  if (state.positionSize === 0 && prevFast <= prevSlow && nowFast > nowSlow) {
    return { type: "openLong", size };
  }
  if (state.positionSize === 0 && prevFast >= prevSlow && nowFast < nowSlow) {
    return { type: "openShort", size };
  }
  if (state.positionSize > 0 && nowFast < nowSlow) return { type: "closePosition" };
  if (state.positionSize < 0 && nowFast > nowSlow) return { type: "closePosition" };
  return { type: "none" };
};
