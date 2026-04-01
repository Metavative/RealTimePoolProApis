import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import {
  myAwards,
  evaluateMyAwards,
  advancedLeaderboard,
  organizerDashboard,
  deepHealth,
} from "../controllers/insights.controller.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

router.get("/leaderboard", authMiddleware, advancedLeaderboard);
router.get("/me/awards", authMiddleware, myAwards);
router.post("/me/awards/evaluate", authMiddleware, evaluateMyAwards);

router.get("/organizer/dashboard", clubAuthMiddleware, organizerDashboard);

router.get("/health/deep", deepHealth);

export default router;
