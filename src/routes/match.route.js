// src/routes/match.routes.js
import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as c from "../controllers/matchController.js";
import {
  myLevelEconomySummary,
  createLevelChallenge,
  startLevelMatch,
  settleLevelMatch,
  cancelLevelMatch,
  myLevelMatches,
  myMatchmakingStatus,
  updateMatchmakingStatus,
  levelMatchmakingCandidates,
  autoCreateLevelChallenge,
} from "../controllers/levelEconomy.controller.js";

const router = express.Router();

router.post("/challenge", authMiddleware, c.createChallenge);
router.post("/accept", authMiddleware, c.acceptChallenge);
router.post("/finish", authMiddleware, c.finishMatch);
router.post("/cancel", authMiddleware, c.cancelMatch);

// Level economy v2 (additive, non-breaking)
router.get("/level/v2/summary", authMiddleware, myLevelEconomySummary);
router.get("/level/v2/matches", authMiddleware, myLevelMatches);
router.post("/level/v2/challenges", authMiddleware, createLevelChallenge);
router.post("/level/v2/matches/:sessionId/start", authMiddleware, startLevelMatch);
router.post("/level/v2/matches/:sessionId/settle", authMiddleware, settleLevelMatch);
router.post("/level/v2/matches/:sessionId/cancel", authMiddleware, cancelLevelMatch);
router.get("/level/v2/matchmaking/status", authMiddleware, myMatchmakingStatus);
router.put("/level/v2/matchmaking/status", authMiddleware, updateMatchmakingStatus);
router.get("/level/v2/matchmaking/candidates", authMiddleware, levelMatchmakingCandidates);
router.post("/level/v2/matchmaking/auto-challenge", authMiddleware, autoCreateLevelChallenge);

export default router;
