import express from "express";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";

import {
  sendTournamentInvite,
  listMyInvites,
  respondToInvite,
  cancelInvite,
} from "../controllers/tournamentInvite.controller.js";

export default function tournamentInviteRoutes(io, presence) {
  const router = express.Router();

  // Organizer sends invite (by username)
  router.post("/tournaments/:tournamentId/invites", auth, (req, res) =>
    sendTournamentInvite(req, res, io, presence)
  );

  // Player inbox
  router.get("/tournament-invites/inbox", auth, listMyInvites);

  // Player respond
  router.post("/tournament-invites/:inviteId/respond", auth, (req, res) =>
    respondToInvite(req, res, io, presence)
  );

  // Organizer cancel
  router.post("/tournament-invites/:inviteId/cancel", auth, (req, res) =>
    cancelInvite(req, res, io, presence)
  );

  return router;
}
