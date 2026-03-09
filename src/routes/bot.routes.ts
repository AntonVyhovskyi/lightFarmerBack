import { Router } from "express";
import { getBotsController, getWSCacheController, startBotController, stopBotController } from "../controllers/bot.controllers";
const router = Router();

router.get("/", getBotsController);
router.get("/cache/:botId", getWSCacheController);
router.post("/start", startBotController);
router.post("/stop", stopBotController);

export default router;