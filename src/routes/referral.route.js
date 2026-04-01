import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  linkReferralCode,
  myReferralSummary,
  myReferralHistory,
} from "../controllers/referral.controller.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

router.get("/me/summary", authMiddleware, myReferralSummary);
router.get("/me/history", authMiddleware, myReferralHistory);
router.post("/me/link", authMiddleware, linkReferralCode);

export default router;
