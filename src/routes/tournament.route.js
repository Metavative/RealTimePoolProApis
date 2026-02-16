import express from "express";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import * as c from "../controllers/tournamentController.js";

const router = express.Router();

router.post("/", clubAuthMiddleware, c.create);
router.get("/my", clubAuthMiddleware, c.listMine);
router.get("/:id", clubAuthMiddleware, c.getOne);
router.patch("/:id", clubAuthMiddleware, c.patch);
router.patch("/:id/settings", clubAuthMiddleware, c.patchSettings);

// ✅ NEW Step endpoints
router.post("/:id/entries/close", clubAuthMiddleware, c.closeEntries);
router.post("/:id/finalise", clubAuthMiddleware, c.finaliseFormat);

// Entrants (users) -> computes rating + seed
router.post("/:id/entrants", clubAuthMiddleware, c.setEntrants);

// Seeded balanced groups
router.post("/:id/groups/generate", clubAuthMiddleware, c.generateGroups);

// Group matches
router.post("/:id/matches/generate-group", clubAuthMiddleware, c.generateGroupMatches);

// Generate matches for any format
router.post("/:id/matches/generate", clubAuthMiddleware, c.generateMatches);

// Playoffs (auto-progress BYEs)
router.post("/:id/playoffs/generate", clubAuthMiddleware, c.generatePlayoffs);

// Update match result (auto-progress + champion)
router.patch("/:id/matches", clubAuthMiddleware, c.upsertMatch);

// Start tournament
router.post("/:id/start", clubAuthMiddleware, c.startTournament);

export default router;
