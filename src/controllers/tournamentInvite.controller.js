import Tournament from "../models/tournament.model.js";
import TournamentInvite from "../models/tournamentInvite.model.js";
import User from "../models/user.model.js";
import * as svc from "../services/tournament.service.js";

// -------------------------
// helpers
// -------------------------
function requireClub(req, res) {
  if (req.authType !== "club" || !req.clubId || !req.club) {
    res.status(403).json({ message: "Club authorization required" });
    return false;
  }
  return true;
}

function requireUser(req, res) {
  if (req.authType !== "user" || !req.userId || !req.user) {
    res.status(403).json({ message: "User authorization required" });
    return false;
  }
  return true;
}

function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bestUserDisplayName(user) {
  return (
    user?.profile?.nickname ||
    user?.profile?.name ||
    user?.name ||
    user?.username ||
    ""
  );
}

function emitToUser(io, presence, userId, event, payload) {
  try {
    const uid = String(userId || "");
    if (!uid) return;

    io?.to?.(`user:${uid}`)?.emit?.(event, payload);

    const sids = presence?.getSocketIds?.(uid) || [];
    for (const sid of sids) io?.to?.(sid)?.emit?.(event, payload);
  } catch (_) {}
}

/**
 * POST /api/tournaments/:tournamentId/invites
 * club-only
 * body: { username, participantKey, message? }
 */
export async function sendTournamentInvite(req, res, io, presence) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    const username = String(req.body.username || "").trim();
    const participantKey = String(req.body.participantKey || "").trim();
    const message = String(req.body.message || "").trim();

    if (!tournamentId)
      return res.status(400).json({ message: "tournamentId is required" });
    if (!username)
      return res.status(400).json({ message: "username is required" });
    if (!participantKey)
      return res.status(400).json({ message: "participantKey is required" });

    const organizerId = String(req.clubId);

    const tournament = await Tournament.findById(tournamentId).select(
      "clubId entriesStatus formatStatus status accessMode"
    );

    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    if (tournament.clubId && String(tournament.clubId) !== String(req.clubId)) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    if (tournament.status === "ACTIVE") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    if (tournament.entriesStatus === "CLOSED") {
      return res
        .status(403)
        .json({ message: "Entries are closed for this tournament" });
    }

    // ✅ NEW: if format finalised, entrants locked (no more invites)
    if (tournament.formatStatus === "FINALISED") {
      return res
        .status(403)
        .json({ message: "Tournament format is finalised. Entrants are locked." });
    }

    // Find user (case-insensitive username match)
    const rx = new RegExp(`^${escapeRegExp(username)}$`, "i");
    const toUser = await User.findOne({ username: rx });
    if (!toUser) return res.status(404).json({ message: "User not found" });

    const existing = await TournamentInvite.findOne({
      tournamentId,
      toUserId: toUser._id,
    });

    if (existing) {
      const st = String(existing.status || "pending").toLowerCase();

      if (st === "pending" || st === "accepted") {
        return res
          .status(200)
          .json({ message: "Invite already exists", data: existing });
      }

      existing.status = "pending";
      existing.message = message || existing.message;
      existing.participantKey = participantKey || existing.participantKey;
      await existing.save();

      emitToUser(io, presence, toUser._id, "tournament_invite:new", {
        inviteId: existing._id,
        tournamentId,
      });

      return res.status(200).json({ message: "Invite re-sent", data: existing });
    }

    const invite = await TournamentInvite.create({
      tournamentId,
      organizerId,
      toUserId: toUser._id,
      toUsername: toUser.username,
      participantKey,
      status: "pending",
      message,
    });

    emitToUser(io, presence, toUser._id, "tournament_invite:new", {
      inviteId: invite._id,
      tournamentId,
    });

    return res.status(201).json({ message: "Invite sent", data: invite });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e?.message || "Failed to send invite" });
  }
}

/**
 * GET /api/tournaments/:tournamentId/invites
 * club-only
 */
export async function listTournamentInvites(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required" });
    }

    const tournament = await Tournament.findById(tournamentId)
      .select("clubId")
      .lean();
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (tournament.clubId && String(tournament.clubId) !== String(req.clubId)) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    const invites = await TournamentInvite.find({ tournamentId })
      .sort({ createdAt: -1 })
      .lean();

    const data = invites.map((inv) => ({
      _id: inv._id,
      tournamentId: inv.tournamentId,
      username: inv.toUsername,
      participantKey: inv.participantKey,
      status: inv.status,
      createdAt: inv.createdAt,
      respondedAt: inv.status === "pending" ? null : inv.updatedAt,
    }));

    return res.status(200).json({ data });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e?.message || "Failed to list invites" });
  }
}

/**
 * ✅ NEW
 * POST /api/tournaments/:tournamentId/join
 * user-only
 * Allows join ONLY when accessMode === OPEN
 */
export async function joinTournamentOpen(req, res) {
  try {
    if (!requireUser(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required" });
    }

    const tournament = await Tournament.findById(tournamentId).select(
      "entriesStatus formatStatus status accessMode entrants"
    );

    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // hard locks
    if (tournament.status === "ACTIVE") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    if (tournament.entriesStatus === "CLOSED") {
      return res
        .status(403)
        .json({ message: "Entries are closed for this tournament" });
    }

    if (tournament.formatStatus === "FINALISED") {
      return res
        .status(403)
        .json({ message: "Tournament format is finalised. Entrants are locked." });
    }

    const mode = String(tournament.accessMode || "INVITE_ONLY").toUpperCase().trim();

    if (mode !== "OPEN") {
      return res.status(403).json({ message: "This tournament is invite-only" });
    }

    // already joined?
    const already = Array.isArray(tournament.entrants)
      ? tournament.entrants.some((e) => String(e.entrantId) === String(req.userId))
      : false;

    if (already) {
      return res.status(200).json({ ok: true, alreadyJoined: true });
    }

    const displayName = bestUserDisplayName(req.user);

    // stable participantKey for in-app users
    const pk = `uid:${String(req.userId)}`;

    await Tournament.updateOne(
      { _id: tournamentId, "entrants.entrantId": { $ne: req.userId } },
      {
        $push: {
          entrants: {
            entrantId: req.userId,
            name: displayName,

            participantKey: pk,
            username: req.user?.username || "",
            userId: String(req.userId || ""),
            isLocal: false,

            rating: 0,
            seed: 0,
          },
        },
      }
    );

    // optional reseed fairness (same behavior as invite accept)
    const fresh = await Tournament.findById(tournamentId).select("entrants");
    const ids = (fresh?.entrants || []).map((e) => String(e.entrantId));
    if (ids.length >= 2) {
      await svc.setEntrants(tournamentId, ids);
    }

    return res.status(200).json({ ok: true, joined: true });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to join tournament" });
  }
}

/**
 * GET /api/tournament-invites/inbox
 * user-only
 */
export async function listMyInvites(req, res) {
  try {
    if (!requireUser(req, res)) return;

    const invites = await TournamentInvite.find({ toUserId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({ data: invites });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e?.message || "Failed to load invites" });
  }
}

/**
 * POST /api/tournament-invites/:inviteId/respond
 * user-only
 * body: { action: "accept" | "decline" }
 */
export async function respondToInvite(req, res, io, presence) {
  try {
    if (!requireUser(req, res)) return;

    const { inviteId } = req.params;
    const action = String(req.body.action || "").trim().toLowerCase();

    if (!inviteId) return res.status(400).json({ message: "inviteId is required" });
    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ message: "action must be accept or decline" });
    }

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ message: "Invite not found" });

    if (String(invite.toUserId) !== String(req.userId)) {
      return res.status(403).json({ message: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res.status(400).json({ message: "Invite already handled" });
    }

    const tournament = await Tournament.findById(invite.tournamentId).select(
      "entriesStatus formatStatus status"
    );

    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (tournament.status === "ACTIVE") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    if (tournament.entriesStatus === "CLOSED") {
      return res
        .status(403)
        .json({ message: "Entries are closed for this tournament" });
    }

    if (tournament.formatStatus === "FINALISED") {
      return res
        .status(403)
        .json({ message: "Tournament format is finalised. Entrants are locked." });
    }

    invite.status = action === "accept" ? "accepted" : "declined";
    await invite.save();

    if (invite.status === "accepted") {
      const displayName = bestUserDisplayName(req.user);

      // ✅ Add entrant if not already present (now with stable participantKey fields)
      await Tournament.updateOne(
        { _id: invite.tournamentId, "entrants.entrantId": { $ne: req.userId } },
        {
          $push: {
            entrants: {
              entrantId: req.userId,
              name: displayName,

              participantKey: invite.participantKey,
              username: req.user?.username || "",
              userId: String(req.userId || ""),
              isLocal: false,

              rating: 0,
              seed: 0,
            },
          },
        }
      );

      // ✅ Re-seed entrants for fairness (and reset derived items) while entries are still open
      const fresh = await Tournament.findById(invite.tournamentId).select("entrants");
      const ids = (fresh?.entrants || []).map((e) => String(e.entrantId));
      if (ids.length >= 2) {
        await svc.setEntrants(invite.tournamentId, ids);
      }
    }

    emitToUser(io, presence, req.userId, "tournament_invite:updated", {
      inviteId: invite._id,
      tournamentId: invite.tournamentId,
      status: invite.status,
    });

    return res.status(200).json({ message: "Invite updated", data: invite });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to respond" });
  }
}

/**
 * POST /api/tournament-invites/:inviteId/cancel
 * club-only
 */
export async function cancelInvite(req, res, io, presence) {
  try {
    if (!requireClub(req, res)) return;

    const { inviteId } = req.params;
    if (!inviteId) return res.status(400).json({ message: "inviteId is required" });

    const organizerId = String(req.clubId);

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ message: "Invite not found" });

    if (String(invite.organizerId) !== organizerId) {
      return res.status(403).json({ message: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res.status(400).json({ message: "Only pending invites can be cancelled" });
    }

    invite.status = "cancelled";
    await invite.save();

    emitToUser(io, presence, invite.toUserId, "tournament_invite:cancelled", {
      inviteId: invite._id,
      tournamentId: invite.tournamentId,
    });

    return res.status(200).json({ message: "Invite cancelled", data: invite });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to cancel invite" });
  }
}
