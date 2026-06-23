import express from "express";
import { authAny } from "../middleware/authAny.middleware.js";

import {
  sendTournamentInvite,
  listTournamentInvites,
  listMyInvites,
  respondToInvite,
  cancelInvite,
  joinTournamentOpen, // ✅ NEW
  leaveTournamentOpen, // ✅ Phase B: safe self-withdraw
} from "../controllers/tournamentInvite.controller.js";

export default function tournamentInviteRoutes(io, presence) {
  const router = express.Router();

  // Organizer (club token) sends invite
  router.post("/tournaments/:tournamentId/invites", authAny, (req, res) =>
    sendTournamentInvite(req, res, io, presence)
  );

  // Organizer (club token) lists invites for a tournament
  router.get("/tournaments/:tournamentId/invites", authAny, (req, res) =>
    listTournamentInvites(req, res)
  );

  // ✅ NEW: Player join (user token) when accessMode === OPEN
  router.post("/tournaments/:tournamentId/join", authAny, (req, res) =>
    joinTournamentOpen(req, res)
  );

  // ✅ Phase B: Player safe self-withdraw (user token)
  router.post("/tournaments/:tournamentId/leave", authAny, (req, res) =>
    leaveTournamentOpen(req, res)
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
