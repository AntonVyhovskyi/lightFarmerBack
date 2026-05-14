import dotenv from "dotenv";
import { initO1Client } from "../bot/exchanges/o1/client";
import { readO1Env } from "../bot/exchanges/o1/env";
import { O1Executor } from "../bot/exchanges/o1/executor";
import {
  fetchActiveTriggers,
  summarizeTrigger,
  syncO1StateFromUser,
} from "../bot/exchanges/o1/liveTestSupport";
import { createInitialO1State } from "../bot/exchanges/o1/state";

dotenv.config();

async function main() {
  const env = readO1Env();
  const { config, nord, user } = await initO1Client();
  const state = createInitialO1State(config);
  const executor = new O1Executor(user, config, state);

  if (!config.accountId) {
    throw new Error("O1 accountId is missing after initialization.");
  }

  const sync = await executor.syncAccount();
  if (!sync.ok) {
    throw new Error("Account sync failed during read-only state check.");
  }

  syncO1StateFromUser(state, user, config.accountId, config.marketId);

  const info = await nord.getInfo();
  const market = info.markets.find((entry) => entry.marketId === config.marketId || entry.symbol === config.symbol);
  const priceDecimals = market?.priceDecimals ?? 2;
  const sizeDecimals = market?.sizeDecimals ?? 4;

  const triggers = await fetchActiveTriggers(nord, config.accountId);
  const marketTriggers = triggers.filter((trigger) => trigger.marketId === config.marketId);

  console.log("[O1_SYNC_STATE_CHECK]", {
    accountId: config.accountId,
    marketId: config.marketId,
    symbol: config.symbol,
    positionSize: state.positionSize,
    entryPrice: state.entryPrice,
    openOrders: state.orders.length,
    activeTriggers: marketTriggers.length,
    balanceTotal: state.balanceTotal,
    balanceAvailable: state.balanceAvailable,
    dryRun: config.dryRun,
    webServerUrl: config.webServerUrl,
  });

  if (state.orders.length > 0) {
    console.log("[O1_SYNC_STATE_CHECK] open-orders", state.orders);
  }

  if (marketTriggers.length > 0) {
    console.log(
      "[O1_SYNC_STATE_CHECK] active-triggers",
      marketTriggers.map((trigger) => summarizeTrigger(trigger, priceDecimals, sizeDecimals))
    );
  }
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error("[O1_SYNC_STATE_CHECK] Failed:", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
