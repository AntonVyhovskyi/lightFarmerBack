import { Router } from "express";
import botRouter from "./bot.routes";
import trailingBotRouter from "./trailingBot.routes";

const router = Router();

router.use("/bot", botRouter);
router.use("/trailingBot", trailingBotRouter);


export default router;