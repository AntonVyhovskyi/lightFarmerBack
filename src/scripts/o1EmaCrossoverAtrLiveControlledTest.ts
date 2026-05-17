/**
 * Phase 2 controlled live test for emaCrossoverAtrLiveStrategy (one entry max).
 */
import dotenv from "dotenv";

dotenv.config();

process.env.O1_STRATEGY = "emaCrossoverAtrLiveStrategy";
process.env.O1_DRY_RUN = "false";
process.env.O1_RESOLUTION = "1";
process.env.O1_EMA_SHORT_PERIOD = "2";
process.env.O1_EMA_LONG_PERIOD = "3";
process.env.O1_ATR_PERIOD = "5";
process.env.O1_ATR_STOP_MULTIPLIER = "0.8";
process.env.O1_BREAK_EVEN_PCT = "0.05";
process.env.O1_TRAILING_START_PCT = "0.05";
process.env.O1_TRAILING_GAP_PCT = "0.1";
process.env.O1_RISK_PCT = "1";
process.env.O1_DEFAULT_LEVERAGE = "3";
process.env.O1_MAX_ORDER_NOTIONAL = "12";
process.env.O1_COOLDOWN_CANDLES = "1";
process.env.O1_CANDLE_POLL_MS = "15000";
process.env.O1_MANAGE_EXISTING_POSITION_ONLY = "false";

import { resetO1Client } from "../bot/exchanges/o1/client";
resetO1Client();

process.env.O1_CONTROLLED_TEST_MAX_MS = process.env.O1_CONTROLLED_TEST_MAX_MS ?? "900000";

await import("./o1ControlledLivePollTest");
