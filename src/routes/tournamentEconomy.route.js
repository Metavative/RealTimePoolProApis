import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import {
  updateTournamentEconomyConfig,
  getTournamentEconomySummary,
  createTournamentEntryIntent,
  syncTournamentEntryPayment,
  myTournamentEntryOrders,
} from "../controllers/tournamentEconomy.controller.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

// Organizer/club controls
router.put("/organizer/tournaments/:tournamentId/config", clubAuthMiddleware, updateTournamentEconomyConfig);
router.get("/organizer/tournaments/:tournamentId/summary", clubAuthMiddleware, getTournamentEconomySummary);

// Player entry payment flow
router.post("/player/tournaments/:tournamentId/entry-intent", authMiddleware, createTournamentEntryIntent);
router.post("/player/entries/:entryOrderId/sync", authMiddleware, syncTournamentEntryPayment);
router.get("/player/me/entries", authMiddleware, myTournamentEntryOrders);

export default router;
