import TournamentInvite from "../models/tournamentInvite.model.js";
import User from "../models/user.model.js";
import Tournament from "../models/tournamentInvite.model.js";

// presence is expected to map userId -> socketIds (Set | Array | string)
function emitToUser(io, presence, userId, event, payload) {
  if (!io || !presence || !userId) return;

  const socketIds = presence?.get?.(String(userId));
  if (!socketIds) return;

  if (Array.isArray(socketIds)) {
    socketIds.forEach((sid) => io.to(sid).emit(event, payload));
    return;
  }

  if (socketIds instanceof Set) {
    socketIds.forEach((sid) => io.to(sid).emit(event, payload));
    return;
  }

  if (typeof socketIds === "string") {
    io.to(socketIds).emit(event, payload);
  }
}

function participantKeyForUser(user) {
  // username is required at signup per your flow
  return `uid:${user._id.toString()}:un:${user.username}`;
}

// POST /api/tournaments/:tournamentId/invites
export async function sendTournamentInvite(req, res, io, presence) {
  try {
    const organizerId = req.user?.id || req.user?._id;
    const { tournamentId } = req.params;
    const { toUsername, participantKey, message = "" } = req.body || {};

    if (!organizerId) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!toUsername || !String(toUsername).trim()) {
      return res.status(400).json({ ok: false, message: "toUsername is required" });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ ok: false, message: "Tournament not found" });

    // adjust if you have club role-based permissions
    if (String(tournament.organizerId) !== String(organizerId)) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }

    const user = await User.findOne({ username: String(toUsername).trim() })
      .select("_id username name")
      .lean();

    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const pk = participantKey?.trim() || participantKeyForUser(user);

    // Optional: mark participant in tournament as pending invite (safe add-on field)
    if (Array.isArray(tournament.participants)) {
      const idx = tournament.participants.findIndex((p) => p?.key === pk);

      if (idx === -1) {
        tournament.participants.push({
          key: pk,
          userId: user._id,
          username: user.username,
          name: user.name || "",
          inviteStatus: "pending",
        });
      } else {
        tournament.participants[idx].inviteStatus =
          tournament.participants[idx].inviteStatus || "pending";
        tournament.participants[idx].userId = tournament.participants[idx].userId || user._id;
        tournament.participants[idx].username =
          tournament.participants[idx].username || user.username;
        tournament.participants[idx].name = tournament.participants[idx].name || (user.name || "");
      }

      await tournament.save();
    }

    const invite = await TournamentInvite.findOneAndUpdate(
      { tournamentId, toUserId: user._id },
      {
        tournamentId,
        organizerId,
        toUserId: user._id,
        toUsername: user.username,
        participantKey: pk,
        message,
        status: "pending",
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    emitToUser(io, presence, user._id, "tournament:invite", {
      inviteId: invite._id,
      tournamentId,
      participantKey: pk,
      message,
      createdAt: invite.createdAt,
    });

    return res.json({ ok: true, invite });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ ok: false, message: "Invite already exists" });
    }
    console.error("sendTournamentInvite error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}

// GET /api/tournament-invites/inbox
export async function listMyInvites(req, res) {
  try {
    const myId = req.user?.id || req.user?._id;
    if (!myId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const invites = await TournamentInvite.find({ toUserId: myId, status: "pending" })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, invites });
  } catch (err) {
    console.error("listMyInvites error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}

// POST /api/tournament-invites/:inviteId/respond  body:{ action:"accept"|"decline" }
export async function respondToInvite(req, res, io, presence) {
  try {
    const myId = req.user?.id || req.user?._id;
    const { inviteId } = req.params;
    const { action } = req.body || {};

    if (!myId) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ ok: false, message: "Invalid action" });
    }

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ ok: false, message: "Invite not found" });
    if (String(invite.toUserId) !== String(myId)) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }
    if (invite.status !== "pending") {
      return res.status(409).json({ ok: false, message: "Invite already handled" });
    }

    invite.status = action === "accept" ? "accepted" : "declined";
    await invite.save();

    const tournament = await Tournament.findById(invite.tournamentId);
    if (tournament && Array.isArray(tournament.participants)) {
      const idx = tournament.participants.findIndex((p) => p?.key === invite.participantKey);
      if (idx !== -1) {
        tournament.participants[idx].inviteStatus = invite.status;
        await tournament.save();
      }
    }

    emitToUser(io, presence, invite.organizerId, "tournament:invite_response", {
      inviteId: invite._id,
      tournamentId: invite.tournamentId,
      participantKey: invite.participantKey,
      status: invite.status,
      toUserId: invite.toUserId,
      toUsername: invite.toUsername,
      updatedAt: invite.updatedAt,
    });

    return res.json({ ok: true, invite });
  } catch (err) {
    console.error("respondToInvite error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}

// POST /api/tournament-invites/:inviteId/cancel (organizer)
export async function cancelInvite(req, res, io, presence) {
  try {
    const organizerId = req.user?.id || req.user?._id;
    const { inviteId } = req.params;

    if (!organizerId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const invite = await TournamentInvite.findById(inviteId);
    if (!invite) return res.status(404).json({ ok: false, message: "Invite not found" });
    if (String(invite.organizerId) !== String(organizerId)) {
      return res.status(403).json({ ok: false, message: "Not allowed" });
    }
    if (invite.status !== "pending") {
      return res.status(409).json({ ok: false, message: "Invite already handled" });
    }

    invite.status = "cancelled";
    await invite.save();

    emitToUser(io, presence, invite.toUserId, "tournament:invite_cancelled", {
      inviteId: invite._id,
      tournamentId: invite.tournamentId,
      participantKey: invite.participantKey,
    });

    return res.json({ ok: true, invite });
  } catch (err) {
    console.error("cancelInvite error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}
