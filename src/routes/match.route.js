import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as c from "../controllers/matchController.js";
 
const router = express.Router();

router.post("/challenge", authMiddleware, c.createChallenge);
router.post("/accept", authMiddleware, c.acceptChallenge);
router.post("/finish", authMiddleware, c.finishMatch);

export default router;