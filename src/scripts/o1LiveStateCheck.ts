import dotenv from "dotenv";
import { Side, TriggerKind } from "@n1xyz/nord-ts";
import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  filterMarketTriggersByKind,
  roundToDecimals,
  sleep,
  summarizeTrigger,
  syncO1StateFromUser,
  toTriggerSpecFromApi,
} from "../bot/exchanges/o1/liveTestSupport";
import { createInitialO1State } from "../bot/exchanges/o1/state";

async function main() {
  process.env.O1_BLOCK_NEW_ENTRIES = "true";
  dotenv.config();
  resetO1Client();
  const { config, nord, user } = await initO1Client();
  const state = createInitialO1State(config);
  const ex = new O1Executor(user, config, state);
  await ex.syncAccount();
  syncO1StateFromUser(state, user, config.accountId!, config.marketId);
  const info = await nord.getInfo();
  const m = info.markets.find((x) => x.marketId === config.marketId)!;
  const triggers = await fetchActiveTriggers(nord, config.accountId!);
  const sl = filterMarketTriggersByKind(triggers, config.marketId, "stopLoss");
  const summaries = sl.map((t) => summarizeTrigger(t, m.priceDecimals, m.sizeDecimals));
  console.log(JSON.stringify({
    accountId: config.accountId,
    positionSize: state.positionSize,
    entryPrice: state.entryPrice,
    openOrders: state.orders.length,
    slCount: sl.length,
    slTriggerIds: sl.map((t) => String(t.triggerId)),
    summaries,
  }, null, 2));
  if (state.positionSize !== 0 && sl.length === 0) {
    const long = state.positionSize > 0;
    const e = state.entryPrice || state.lastPrice;
    const p = long ? roundToDecimals(e * 0.9975, m.priceDecimals) : roundToDecimals(e * 1.0025, m.priceDecimals);
    const r = await ex.placeInitialStopLoss({
      marketId: config.marketId,
      side: long ? Side.Ask : Side.Bid,
      kind: TriggerKind.StopLoss,
      triggerPrice: p,
      limitPrice: p,
      limitBaseSize: Math.abs(state.positionSize),
    }, m.priceDecimals, m.sizeDecimals);
    console.log("PLACED_SL", r);
    await sleep(2000);
    const triggers2 = await fetchActiveTriggers(nord, config.accountId!);
    const sl2 = filterMarketTriggersByKind(triggers2, config.marketId, "stopLoss");
    console.log("AFTER_SL", sl2.map((t) => toTriggerSpecFromApi(t, m.priceDecimals, m.sizeDecimals)));
    if (sl2.length === 0) {
      console.log("CLOSING - SL failed");
      await ex.closePosition();
    }
  }
  if (sl.length > 1) {
    const sorted = [...sl].sort((a, b) => Number(a.triggerId) - Number(b.triggerId));
    for (const extra of sorted.slice(0, -1)) {
      const spec = toTriggerSpecFromApi(extra, m.priceDecimals, m.sizeDecimals);
      console.log("REMOVE_DUP", String(extra.triggerId));
      await ex.removeKnownTrigger(spec);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
