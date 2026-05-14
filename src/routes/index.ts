import { Router } from "express";
import botRouter from "./bot.routes";
import trailingBotRouter from "./trailingBot.routes";
import o1BotRouter from "./o1Bot.routes";

const router = Router();

router.use("/bot", botRouter);
router.use("/trailingBot", trailingBotRouter);
router.use("/o1-bot", o1BotRouter);


export default router;