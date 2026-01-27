import { Router } from "express";
import botRouter from "./bot.routes";

const router = Router();

router.use("/bot", botRouter);

export default router;