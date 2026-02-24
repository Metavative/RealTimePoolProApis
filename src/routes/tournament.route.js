// src/routes/tournament.routes.js
import express from "express";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js";
import * as c from "../controllers/tournamentController.js";

const router = express.Router();

// list tournaments for this club
router.get("/", clubAuthMiddleware, c.listMine);

// create tournament
router.post("/", clubAuthMiddleware, c.create);

// legacy compat
router.get("/my", clubAuthMiddleware, c.listMine);

// get / update tournament
router.get("/:id", clubAuthMiddleware, c.getOne);
router.patch("/:id", clubAuthMiddleware, c.patch);
router.patch("/:id/settings", clubAuthMiddleware, c.patchSettings);

// Step endpoints
router.post("/:id/entries/close", clubAuthMiddleware, c.closeEntries);
router.post("/:id/entries/open", clubAuthMiddleware, c.openEntries);

// Step 3: Format configure/finalise
router.post("/:id/format/configure", clubAuthMiddleware, c.configureFormat);
router.post("/:id/format/finalise", clubAuthMiddleware, c.finaliseFormat);

// ✅ Entrants sync (server truth)
router.post("/:id/entrants", clubAuthMiddleware, c.setEntrantsObjects);

// ✅ Groups + matches generation (server truth)
router.post("/:id/groups/generate", clubAuthMiddleware, c.generateGroups);
router.post("/:id/matches/generate-group", clubAuthMiddleware, c.generateGroupMatches);
router.post("/:id/matches/generate", clubAuthMiddleware, c.generateMatchesForFormat);

// ✅ Match patching (server truth; handles playoffs propagation)
router.patch("/:id/matches", clubAuthMiddleware, c.patchMatch);

// ✅ Playoffs (server truth)
router.post("/:id/playoffs/generate", clubAuthMiddleware, c.generatePlayoffs);
router.delete("/:id/playoffs", clubAuthMiddleware, c.clearPlayoffs);

// ✅ Start
router.post("/:id/start", clubAuthMiddleware, c.startTournament);

export default router;