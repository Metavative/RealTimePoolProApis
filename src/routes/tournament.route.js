import express from "express";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import * as c from "../controllers/tournamentController.js";

const router = express.Router();

router.post("/", clubAuthMiddleware, c.create);
router.get("/:id", clubAuthMiddleware, c.getOne);
router.patch("/:id", clubAuthMiddleware, c.patch);

// Entrants (users) -> computes rating + seed
router.post("/:id/entrants", clubAuthMiddleware, c.setEntrants);

// Seeded balanced groups
router.post("/:id/groups/generate", clubAuthMiddleware, c.generateGroups);

// Group matches
router.post("/:id/matches/generate-group", clubAuthMiddleware, c.generateGroupMatches);

// Playoffs (auto-progress BYEs)
router.post("/:id/playoffs/generate", clubAuthMiddleware, c.generatePlayoffs);

// Update match result (auto-progress + champion)
router.patch("/:id/matches", clubAuthMiddleware, c.upsertMatch);

export default router;
