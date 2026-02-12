import express from "express";
import { authAny } from "../middleware/authAny.middleware.js";

import {
  sendTournamentInvite,
  listMyInvites,
  respondToInvite,
  cancelInvite,
} from "../controllers/tournamentInvite.controller.js";

export default function tournamentInviteRoutes(io, presence) {
  const router = express.Router();

  // Organizer (club token) sends invite
  router.post("/tournaments/:tournamentId/invites", authAny, (req, res) =>
    sendTournamentInvite(req, res, io, presence)
  );

  // Player inbox (user token)
  router.get("/tournament-invites/inbox", authAny, (req, res) =>
    listMyInvites(req, res)
  );

  // Player respond (user token)
  router.post("/tournament-invites/:inviteId/respond", authAny, (req, res) =>
    respondToInvite(req, res, io, presence)
  );

  // Organizer cancel (club token)
  router.post("/tournament-invites/:inviteId/cancel", authAny, (req, res) =>
    cancelInvite(req, res, io, presence)
  );

  return router;
}
