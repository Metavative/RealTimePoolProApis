import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import {
  createDisputeCase,
  myDisputeCases,
  organizerDisputeCases,
  getDisputeCase,
  commentOnDispute,
  escalateDispute,
  resolveDisputeAsUser,
  resolveDisputeAsOrganizer,
} from "../controllers/dispute.controller.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

// Player/user workflow
router.post("/cases", authMiddleware, createDisputeCase);
router.get("/me/cases", authMiddleware, myDisputeCases);
router.get("/cases/:caseId", authMiddleware, getDisputeCase);
router.post("/cases/:caseId/comment", authMiddleware, commentOnDispute);
router.post("/cases/:caseId/escalate", authMiddleware, escalateDispute);
router.post("/cases/:caseId/resolve", authMiddleware, resolveDisputeAsUser);

// Organizer first-stop workflow
router.get("/organizer/cases", clubAuthMiddleware, organizerDisputeCases);
router.post("/organizer/cases/:caseId/resolve", clubAuthMiddleware, resolveDisputeAsOrganizer);

export default router;
