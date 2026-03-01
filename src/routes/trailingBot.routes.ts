import { Router } from "express";
import { getTrailingBotsController, startTrailingBotController, stopTrailingBotController } from "../controllers/trailingBotController";
const router = Router();

router.get("/", getTrailingBotsController);
router.post("/start", startTrailingBotController);
router.post("/stop", stopTrailingBotController);

export default router;