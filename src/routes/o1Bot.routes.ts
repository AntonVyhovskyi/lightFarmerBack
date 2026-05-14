import { Router } from "express";
import {
  forceO1SyncController,
  getO1BotsController,
  getO1DiagnosticsController,
  setO1EmergencyStopController,
  startO1BotController,
  stopO1BotController,
} from "../controllers/o1BotController";

const router = Router();

router.get("/", getO1BotsController);
router.get("/diagnostics/:botId", getO1DiagnosticsController);
router.post("/start", startO1BotController);
router.post("/stop", stopO1BotController);
router.post("/sync", forceO1SyncController);
router.post("/emergency-stop", setO1EmergencyStopController);

export default router;
