import Tournament from "../models/tournament.model.js";
import TournamentInvite from "../models/tournamentInvite.model.js";
import User from "../models/user.model.js";

// helper
function requireClub(req, res) {
  if (req.authType !== "club" || !req.clubId) {
    res.status(403).json({ message: "Club authorization required" });
    return false;
  }
  return true;
}

function requireUser(req, res) {
  if (req.authType !== "user" || !req.userId) {
    res.status(403).json({ message: "User authorization required" });
    return false;
  }
  return true;
}

/**
 * POST /api/tournaments/:tournamentId/invites
 * club-only
 * body: { username, message? }
 */
export async function sendTournamentInvite(req, res, io, presence) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    const username = (req.body.username || "").trim();
    const message = (req.body.message || "").trim();

    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required" });
    }
    if (!username) {
      return res.status(400).json({ message: "username is required" });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    // Ensure this tournament belongs to this club (adjust field names to your schema)
    // Common: tournament.clubId or tournament.organizerClubId
    const ownerClubId =
      tournament.clubId?.toString?.() ||
      tournament.club?.toString?.() ||
      tournament.organizerClubId?.toString?.();

    if (ownerClubId && ownerClubId !== req.clubId) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    const user = await User.findOne({ username: new RegExp(`^${username}$`, "i") });
    if (!user) return res.status(404).json({ message: "User not found" });

    // prevent duplicates (pending)
    const existing = await TournamentInvite.findOne({
      tournamentId,
      toUserId: user._id,
      status: "pending",
    });

    if (existing) {
      return res.status(200).json({ message: "Invite already pending", data: existing });
    }

    const invite = await TournamentInvite.create({
      tournamentId,
      fromClubId: req.clubId,
      toUserId: user._id,
      toUsername: user.username,
      message,
      status: "pending",
      createdAt: new Date(),
    });

    // optional realtime ping
    try {
      io?.to?.(user._id.toString())?.emit?.("tournament_invite:new", {
        inviteId: invite._id,
        tournamentId,
      });
    } catch (_) {}

    return res.status(201).json({ message: "Invite sent", data: invite });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to send invite" });
  }
}

/**
 * GET /api/tournament-invites/inbox
 * user-only
 */
export async function listMyInvites(req, res) {
  try {
    if (!requireUser(req, res)) return;

    const invites = await TournamentInvite.find({
      toUserId: req.userId,
    })
      .sort({ createdAt: -1 })
      .limit(50);

    return res.status(200).json({ data: invites });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load invites" });
  }
}

/**
 * POST /api/tournament-invites/:inviteId/respond
 * user-only
 * body: { action: "accept" | "reject" }
 */
export async function respondToInvite(req, res, io, presence) {
  try {
    if (!requireUser(req, res)) return;

    const { inviteId } = req.params;
    const action = (req.body.action || "").trim().toLowerCase();

    if (!inviteId) return res.status(400).json({ message: "inviteId is required" });
    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be accept or reject" });
    }

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ message: "Invite not found" });

    if (invite.toUserId.toString() !== req.userId) {
      return res.status(403).json({ message: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res.status(400).json({ message: "Invite already handled" });
    }

    invite.status = action === "accept" ? "accepted" : "rejected";
    invite.respondedAt = new Date();
    await invite.save();

    // If accepted, add participant to tournament (adjust to your tournament schema)
    if (invite.status === "accepted") {
      await Tournament.updateOne(
        { _id: invite.tournamentId },
        {
          $addToSet: {
            participants: {
              userId: req.userId,
              username: req.user?.username,
              name: req.user?.name || req.user?.username,
            },
          },
        }
      );
    }

    return res.status(200).json({ message: "Invite updated", data: invite });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to respond" });
  }
}

/**
 * POST /api/tournament-invites/:inviteId/cancel
 * club-only
 */
export async function cancelInvite(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { inviteId } = req.params;
    if (!inviteId) return res.status(400).json({ message: "inviteId is required" });

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ message: "Invite not found" });

    if (invite.fromClubId?.toString?.() && invite.fromClubId.toString() !== req.clubId) {
      return res.status(403).json({ message: "Not your invite" });
    }

    if (invite.status !== "pending") {
      return res.status(400).json({ message: "Only pending invites can be cancelled" });
    }

    invite.status = "cancelled";
    invite.cancelledAt = new Date();
    await invite.save();

    return res.status(200).json({ message: "Invite cancelled", data: invite });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to cancel invite" });
  }
}
