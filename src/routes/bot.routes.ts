import { Router } from "express";
import { getBotsController, startBotController, stopBotController } from "../controllers/bot.controllers";
const router = Router();

router.get("/", getBotsController);
router.post("/start", startBotController);
router.post("/stop", stopBotController);

export default router;