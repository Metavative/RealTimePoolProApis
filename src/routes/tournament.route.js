// src/routes/tournament.routes.js
import express from "express";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import * as c from "../controllers/tournamentController.js";

const router = express.Router();

// ✅ FIX: Flutter is calling GET /api/tournaments?scope=club
// Your router previously had no GET "/" route, so Express returned:
// "Cannot GET /api/tournaments" (404 HTML)
// This makes GET "/" behave like your existing "listMine".
router.get("/", clubAuthMiddleware, c.listMine);

// Create tournament
router.post("/", clubAuthMiddleware, c.create);

// Keep existing endpoint for compatibility
router.get("/my", clubAuthMiddleware, c.listMine);

// Get / update tournament
router.get("/:id", clubAuthMiddleware, c.getOne);
router.patch("/:id", clubAuthMiddleware, c.patch);
router.patch("/:id/settings", clubAuthMiddleware, c.patchSettings);

// Step endpoints
router.post("/:id/entries/close", clubAuthMiddleware, c.closeEntries);
router.post("/:id/entries/open", clubAuthMiddleware, c.openEntries);

router.post("/:id/finalise", clubAuthMiddleware, c.finaliseFormat);

// Entrants
router.post("/:id/entrants", clubAuthMiddleware, c.setEntrants);

// Groups
router.post("/:id/groups/generate", clubAuthMiddleware, c.generateGroups);

// Group matches
router.post(
  "/:id/matches/generate-group",
  clubAuthMiddleware,
  c.generateGroupMatches
);

// Generate matches for any format (✅ persists and supports double_elim)
router.post("/:id/matches/generate", clubAuthMiddleware, c.generateMatches);

// Playoffs
router.post("/:id/playoffs/generate", clubAuthMiddleware, c.generatePlayoffs);

// Update match
router.patch("/:id/matches", clubAuthMiddleware, c.upsertMatch);

// Start tournament
router.post("/:id/start", clubAuthMiddleware, c.startTournament);

export default router;
