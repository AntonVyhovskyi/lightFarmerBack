import dotenv from "dotenv";
dotenv.config();
process.env.O1_STRATEGY = "emaCrossoverAtrLiveStrategy";
process.env.O1_RESOLUTION = "1";
process.env.O1_EMA_SHORT_PERIOD = "12";
process.env.O1_EMA_LONG_PERIOD = "24";
process.env.O1_ATR_PERIOD = "14";
process.env.O1_STRENGTH_LOOKBACK_CANDLES = "5";

import { resetO1Client } from "../bot/exchanges/o1/client";
import { O1BotManager } from "../bot/exchanges/o1/manager";

async function main() {
  resetO1Client();
  const manager = new O1BotManager();
  const botId = "o1-SOLUSD-1";
  const result = await manager.getSafeDiagnostics(botId);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
