// src/routes/tournament.routes.js
import express from "express";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import * as c from "../controllers/tournamentController.js";

const router = express.Router();

// ✅ Flutter calling GET /api/tournaments?scope=club
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

// ✅ Step 3: Format configure/finalise
router.post("/:id/format/configure", clubAuthMiddleware, c.configureFormat);
router.post("/:id/format/finalise", clubAuthMiddleware, c.finaliseFormat);

// ✅ Backwards compatible alias (previous endpoint used by Flutter)
router.post("/:id/finalise", clubAuthMiddleware, c.finaliseFormat);

// Entrants
router.post("/:id/entrants", clubAuthMiddleware, c.setEntrants);

// Groups
router.post("/:id/groups/generate", clubAuthMiddleware, c.generateGroups);

// Group matches
router.post("/:id/matches/generate-group", clubAuthMiddleware, c.generateGroupMatches);

// Generate matches for any format
router.post("/:id/matches/generate", clubAuthMiddleware, c.generateMatches);

// Playoffs
router.post("/:id/playoffs/generate", clubAuthMiddleware, c.generatePlayoffs);

router.delete("/:id/playoffs", clubAuthMiddleware, c.clearPlayoffs);

// Update match (more specific first for Flutter PATCH .../matches/:matchId)
router.patch("/:id/matches/:matchId", clubAuthMiddleware, c.patchMatchById);
router.patch("/:id/matches", clubAuthMiddleware, c.upsertMatch);

// Start tournament
router.post("/:id/start", clubAuthMiddleware, c.startTournament);

export default router;
