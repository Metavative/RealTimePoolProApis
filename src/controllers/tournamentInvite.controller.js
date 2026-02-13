import Tournament from "../models/tournament.model.js";
import TournamentInvite from "../models/tournamentInvite.model.js";
import User from "../models/user.model.js";

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

    // Your server does: socket.join(`user:${uid}`)
    io?.to?.(`user:${uid}`)?.emit?.(event, payload);

    // fallback (your presence helper returns socketIds array)
    const sids = presence?.getSocketIds?.(uid) || [];
    for (const sid of sids) io?.to?.(sid)?.emit?.(event, payload);
  } catch (_) {}
}

/**
 * POST /api/tournaments/:tournamentId/invites
 * club-only (authAny must set req.club + req.clubId)
 * body: { username, participantKey, message? }
 */
export async function sendTournamentInvite(req, res, io, presence) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    const username = String(req.body.username || "").trim();
    const participantKey = String(req.body.participantKey || "").trim();
    const message = String(req.body.message || "").trim();

    if (!tournamentId) return res.status(400).json({ message: "tournamentId is required" });
    if (!username) return res.status(400).json({ message: "username is required" });
    if (!participantKey) return res.status(400).json({ message: "participantKey is required" });

    // organizerId is the CLUB OWNER user id
    const organizerId = req.club?.owner ? String(req.club.owner) : "";
    if (!organizerId) {
      return res.status(400).json({
        message: "Club owner is missing. Set Club.owner to the organizer User id.",
      });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    // Ensure tournament belongs to this club
    if (tournament.clubId && String(tournament.clubId) !== String(req.clubId)) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    // Find user (case-insensitive)
    const rx = new RegExp(`^${escapeRegExp(username)}$`, "i");
    const toUser = await User.findOne({ username: rx });
    if (!toUser) return res.status(404).json({ message: "User not found" });

    // One invite per tournament per user (your unique index enforces this)
    const existing = await TournamentInvite.findOne({
      tournamentId,
      toUserId: toUser._id,
    });

    if (existing) {
      return res.status(200).json({ message: "Invite already exists", data: existing });
    }

    const invite = await TournamentInvite.create({
      tournamentId,
      organizerId, // ✅ real User id from club.owner
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
    return res.status(500).json({ message: e?.message || "Failed to send invite" });
  }
}

/**
 * GET /api/tournaments/:tournamentId/invites
 * club-only (organizer lists all invites for a tournament)
 */
export async function listTournamentInvites(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required" });
    }

    const tournament = await Tournament.findById(tournamentId).select("clubId").lean();
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Ensure tournament belongs to this club
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
    return res.status(500).json({ message: e?.message || "Failed to list invites" });
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
    return res.status(500).json({ message: e?.message || "Failed to load invites" });
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

    invite.status = action === "accept" ? "accepted" : "declined";
    await invite.save();

    if (invite.status === "accepted") {
      const displayName = bestUserDisplayName(req.user);

      // Tournament uses entrants[] (not participants)
      await Tournament.updateOne(
        { _id: invite.tournamentId, "entrants.entrantId": { $ne: req.userId } },
        {
          $push: {
            entrants: {
              entrantId: req.userId,
              name: displayName,
              rating: 0,
              seed: 0,
            },
          },
        }
      );
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

    const organizerId = req.club?.owner ? String(req.club.owner) : "";
    if (!organizerId) {
      return res.status(400).json({
        message: "Club owner is missing. Set Club.owner to the organizer User id.",
      });
    }

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ message: "Invite not found" });

    // ✅ Must be the same organizer (club owner user)
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
