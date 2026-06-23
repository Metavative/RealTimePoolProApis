// src/controllers/tournamentInvite.controller.js
import Tournament from "../models/tournament.model.js";
import TournamentInvite from "../models/tournamentInvite.model.js";
import TournamentEntryOrder from "../models/tournamentEntryOrder.model.js";
import User from "../models/user.model.js";

// -------------------------
// helpers
// -------------------------
function requireClub(req, res) {
  const isClub =
    req.authType === "club" ||
    req.auth?.tokenRole === "CLUB" ||
    !!req.clubId ||
    !!req.club;

  if (!isClub || !req.clubId || !req.club) {
    res.status(403).json({ message: "Club authorization required" });
    return false;
  }
  return true;
}

function requirePlayableUser(req, res) {
  const hasUserIdentity = !!req.userId && !!req.user;
  const canPlay =
    req.authType === "user" ||
    req.auth?.canPlay === true ||
    req.auth?.actorType === "club_owner_as_player";

  if (!hasUserIdentity || !canPlay) {
    res.status(403).json({ message: "User authorization required" });
    return false;
  }
  return true;
}

function normUpper(v, fallback) {
  return String(v ?? fallback ?? "").trim().toUpperCase();
}

function isActiveStatus(status) {
  const s = normUpper(status, "DRAFT");
  return s === "ACTIVE" || s === "LIVE";
}

function isEntriesClosed(t) {
  return normUpper(t?.entriesStatus, "OPEN") === "CLOSED";
}

function isFormatFinalised(t) {
  return normUpper(t?.formatStatus, "DRAFT") === "FINALISED";
}

function ensureRosterMutableOrRespond(res, tournament) {
  if (!tournament) {
    res.status(404).json({ message: "Tournament not found" });
    return false;
  }

  const status = normUpper(tournament.status, "DRAFT");
  if (isActiveStatus(status) || status === "COMPLETED") {
    res.status(409).json({ message: "Tournament already started" });
    return false;
  }

  if (isEntriesClosed(tournament)) {
    res.status(409).json({ message: "Entries are closed for this tournament" });
    return false;
  }

  if (isFormatFinalised(tournament)) {
    res.status(409).json({
      message: "Tournament format is finalised. Entrants are locked.",
    });
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

function resolveParticipantKeyForUser(req, fallbackUserId) {
  const uid = String(req.userId || fallbackUserId || "").trim();
  if (!uid) return "";
  return `uid:${uid}`;
}

function safeUsername(user) {
  return String(user?.username || "").trim();
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

    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required" });
    }
    if (!username) {
      return res.status(400).json({ message: "username is required" });
    }

    const tournament = await Tournament.findById(tournamentId).select(
      "clubId entriesStatus formatStatus status accessMode"
    );

    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (tournament.clubId && String(tournament.clubId) !== String(req.clubId)) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    if (!ensureRosterMutableOrRespond(res, tournament)) return;

    const rx = new RegExp(`^${escapeRegExp(username)}$`, "i");
    const toUser = await User.findOne({ username: rx });
    if (!toUser) return res.status(404).json({ message: "User not found" });

    const requesterUserId = String(req.userId || "").trim();
    const requesterUsername = String(req.user?.username || "")
      .trim()
      .toLowerCase();
    const targetUserId = String(toUser._id || "").trim();
    const targetUsername = String(toUser.username || "")
      .trim()
      .toLowerCase();

    if (
      (requesterUserId && targetUserId && requesterUserId === targetUserId) ||
      (requesterUsername &&
        targetUsername &&
        requesterUsername === targetUsername)
    ) {
      return res
        .status(400)
        .json({ message: "You cannot send a tournament invite to yourself" });
    }

    const resolvedParticipantKey =
      participantKey || `uid:${String(toUser._id)}`;

    const existing = await TournamentInvite.findOne({
      tournamentId,
      toUserId: toUser._id,
    });

    if (existing) {
      const st = String(existing.status || "pending").toLowerCase();

      if (st === "pending" || st === "accepted") {
        return res.status(200).json({ message: "Invite already exists", data: existing });
      }

      existing.status = "pending";
      existing.message = message || existing.message;
      existing.participantKey = resolvedParticipantKey || existing.participantKey;
      existing.toUsername = toUser.username || existing.toUsername;

      await existing.save();

      emitToUser(io, presence, toUser._id, "tournament_invite:new", {
        inviteId: existing._id,
        tournamentId,
      });

      return res.status(200).json({ message: "Invite re-sent", data: existing });
    }

    const invite = await TournamentInvite.create({
      tournamentId,
      organizerId: req.clubId,
      toUserId: toUser._id,
      toUsername: toUser.username,
      participantKey: resolvedParticipantKey,
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
 * club-only
 */
export async function listTournamentInvites(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId) return res.status(400).json({ message: "tournamentId is required" });

    const tournament = await Tournament.findById(tournamentId).select("clubId").lean();
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (tournament.clubId && String(tournament.clubId) !== String(req.clubId)) {
      return res.status(403).json({ message: "Not allowed for this tournament" });
    }

    const invites = await TournamentInvite.find({ tournamentId }).sort({ createdAt: -1 }).lean();

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
 * POST /api/tournaments/:tournamentId/join
 * user or playable venue-owner
 * Allows join ONLY when accessMode === OPEN
 */
export async function joinTournamentOpen(req, res) {
  try {
    if (!requirePlayableUser(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId) return res.status(400).json({ message: "tournamentId is required" });

    const tournament = await Tournament.findById(tournamentId).select(
      "entriesStatus formatStatus status accessMode entrants maxPlayers"
    );

    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (!ensureRosterMutableOrRespond(res, tournament)) return;

    const mode = normUpper(tournament.accessMode, "INVITE_ONLY");
    if (mode !== "OPEN") {
      return res.status(403).json({ message: "This tournament is invite-only" });
    }

    const userId = String(req.userId);
    const already = Array.isArray(tournament.entrants)
      ? tournament.entrants.some((e) => String(e.entrantId) === userId)
      : false;

    if (already) {
      return res.status(200).json({ ok: true, alreadyJoined: true });
    }

    // Optional capacity cap (0 = unlimited). Soft pre-check for a clear message;
    // the authoritative guard is the atomic $expr filter below (race-safe).
    const cap = Math.max(0, Number(tournament.maxPlayers || 0));
    const currentCount = Array.isArray(tournament.entrants)
      ? tournament.entrants.length
      : 0;
    if (cap > 0 && currentCount >= cap) {
      return res.status(409).json({
        ok: false,
        code: "TOURNAMENT_FULL",
        message: "This tournament is full.",
        maxPlayers: cap,
        entrantCount: currentCount,
      });
    }

    const displayName = bestUserDisplayName(req.user);
    const pk = resolveParticipantKeyForUser(req, req.userId);

    // Atomic claim: only push if the user is not already an entrant AND (when a
    // cap is set) the roster still has room. Prevents double-entry and
    // over-capacity races without a transaction.
    const filter = { _id: tournamentId, "entrants.entrantId": { $ne: req.userId } };
    if (cap > 0) {
      filter.$expr = { $lt: [{ $size: { $ifNull: ["$entrants", []] } }, cap] };
    }

    const result = await Tournament.updateOne(filter, {
      $push: {
        entrants: {
          entrantId: req.userId,
          name: displayName,
          participantKey: pk,
          username: safeUsername(req.user),
          userId: userId,
          isLocal: false,
          rating: 0,
          seed: 0,
        },
      },
    });

    if (!result.modifiedCount) {
      // The atomic filter rejected the write — re-read to report the exact cause.
      const fresh = await Tournament.findById(tournamentId)
        .select("entrants maxPlayers")
        .lean();
      const freshEntrants = Array.isArray(fresh?.entrants) ? fresh.entrants : [];
      const nowJoined = freshEntrants.some((e) => String(e.entrantId) === userId);
      if (nowJoined) {
        return res.status(200).json({ ok: true, alreadyJoined: true });
      }
      return res.status(409).json({
        ok: false,
        code: "TOURNAMENT_FULL",
        message: "This tournament is full.",
        maxPlayers: cap,
        entrantCount: freshEntrants.length,
      });
    }

    return res.status(200).json({
      ok: true,
      joined: true,
      actorType: req?.auth?.actorType || "user",
    });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to join tournament" });
  }
}

// Pure mapper for a discovery row → client view. Exported for unit testing.
// `viewerId` is the requesting user's id (string) used to compute alreadyJoined.
export function buildDiscoveryView(t = {}, viewerId = "") {
  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  const entrantCount = entrants.length;
  const cap = Math.max(0, Number(t.maxPlayers || 0));
  const isFull = cap > 0 && entrantCount >= cap;
  const vid = String(viewerId || "");
  const alreadyJoined = vid
    ? entrants.some((e) => String(e.entrantId) === vid)
    : false;
  const economy = t.economy || {};
  const feeEnabled = !!economy.enabled;

  return {
    id: String(t._id),
    title: t.title || "",
    format: t.format || "",
    status: t.status || "DRAFT",
    accessMode: t.accessMode || "INVITE_ONLY",
    entriesStatus: t.entriesStatus || "OPEN",
    clubId: t.clubId ? String(t.clubId) : null,
    entrantCount,
    maxPlayers: cap,
    isFull,
    alreadyJoined,
    joinable: !isFull && !alreadyJoined,
    entryFee: feeEnabled
      ? {
          enabled: true,
          currency: economy.currency || "GBP",
          amountMinor: Number(economy.entryFeeMinor || 0),
        }
      : { enabled: false },
    createdAt: t.createdAt,
  };
}

/**
 * GET /api/tournaments/discover
 * user or playable venue-owner
 * Player-facing discovery of OPEN, joinable tournaments. Additive — does not
 * touch the club-only listing (listMine). Read-only.
 *
 * Query: q (title search), format, hasFee ("true"/"false"), page, limit
 */
export async function discoverTournaments(req, res) {
  try {
    if (!requirePlayableUser(req, res)) return;

    const q = req.query || {};

    // Joinable = self-join allowed: OPEN access, entries OPEN, not yet started,
    // and format not finalised (roster still mutable).
    const criteria = {
      accessMode: "OPEN",
      entriesStatus: "OPEN",
      status: { $nin: ["ACTIVE", "LIVE", "COMPLETED"] },
      formatStatus: { $ne: "FINALISED" },
    };

    const search = String(q.q || q.search || "").trim();
    if (search) {
      criteria.title = { $regex: escapeRegExp(search), $options: "i" };
    }

    const format = String(q.format || "").trim().toLowerCase();
    if (format) criteria.format = format;

    const hasFee = String(q.hasFee ?? "").trim().toLowerCase();
    if (hasFee === "true") criteria["economy.enabled"] = true;
    else if (hasFee === "false") criteria["economy.enabled"] = { $ne: true };

    const limitRaw = Number(q.limit || 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.round(limitRaw)))
      : 50;
    const pageRaw = Number(q.page || 1);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.round(pageRaw)) : 1;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      Tournament.find(criteria)
        .select(
          "title format status accessMode entriesStatus formatStatus maxPlayers entrants economy clubId createdAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Tournament.countDocuments(criteria),
    ]);

    const viewerId = String(req.userId || "");
    const data = rows.map((t) => buildDiscoveryView(t, viewerId));

    return res.status(200).json({
      data,
      meta: {
        page,
        limit,
        total,
        hasMore: skip + rows.length < total,
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e?.message || "Failed to load tournaments" });
  }
}

/**
 * POST /api/tournaments/:tournamentId/leave
 * user or playable venue-owner
 * Safe self-withdrawal: allowed only while the roster is still mutable
 * (entries open, not started, not finalised) AND the player has NOT paid an
 * entry fee. Paid withdrawals require an organiser refund and are out of scope
 * here (Phase C money flows) — we refuse rather than silently strand money.
 */
export async function leaveTournamentOpen(req, res) {
  try {
    if (!requirePlayableUser(req, res)) return;

    const { tournamentId } = req.params;
    if (!tournamentId)
      return res.status(400).json({ message: "tournamentId is required" });

    const tournament = await Tournament.findById(tournamentId).select(
      "entriesStatus formatStatus status accessMode entrants"
    );
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    const userId = String(req.userId);
    const isEntrant = Array.isArray(tournament.entrants)
      ? tournament.entrants.some((e) => String(e.entrantId) === userId)
      : false;

    if (!isEntrant) {
      return res.status(200).json({ ok: true, alreadyLeft: true });
    }

    // Roster must still be mutable to self-leave (mirrors join gating).
    if (!ensureRosterMutableOrRespond(res, tournament)) return;

    // Block self-leave if the player paid an entry fee — money must be refunded
    // by the organiser first (Phase C). This protects against losing track of
    // captured funds.
    const paidOrder = await TournamentEntryOrder.findOne({
      tournamentId,
      userId: req.userId,
      status: "PAID",
    })
      .select("_id status")
      .lean();

    if (paidOrder) {
      return res.status(409).json({
        ok: false,
        code: "ENTRY_FEE_PAID",
        message:
          "You have paid an entry fee. Please request a refund from the organiser to withdraw.",
      });
    }

    const result = await Tournament.updateOne(
      { _id: tournamentId },
      { $pull: { entrants: { entrantId: req.userId } } }
    );

    return res.status(200).json({
      ok: true,
      left: result.modifiedCount > 0,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ message: e?.message || "Failed to leave tournament" });
  }
}

/**
 * GET /api/tournament-invites/inbox
 * user or playable venue-owner
 */
export async function listMyInvites(req, res) {
  try {
    if (!requirePlayableUser(req, res)) return;

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
 * user or playable venue-owner
 * body: { action: "accept" | "decline" }
 */
export async function respondToInvite(req, res, io, presence) {
  try {
    if (!requirePlayableUser(req, res)) return;

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

    if (String(invite.status || "").toLowerCase() !== "pending") {
      return res.status(400).json({ message: "Invite already handled" });
    }

    const tournament = await Tournament.findById(invite.tournamentId).select(
      "entriesStatus formatStatus status accessMode entrants"
    );
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    if (action === "accept") {
      if (!ensureRosterMutableOrRespond(res, tournament)) return;

      const already = Array.isArray(tournament.entrants)
        ? tournament.entrants.some((e) => String(e.entrantId) === String(req.userId))
        : false;

      if (!already) {
        const displayName = bestUserDisplayName(req.user);
        const participantKey =
          String(invite.participantKey || "").trim() ||
          resolveParticipantKeyForUser(req, req.userId);

        await Tournament.updateOne(
          { _id: invite.tournamentId, "entrants.entrantId": { $ne: req.userId } },
          {
            $push: {
              entrants: {
                entrantId: req.userId,
                name: displayName,
                participantKey,
                username: safeUsername(req.user),
                userId: String(req.userId || ""),
                isLocal: false,
                rating: 0,
                seed: 0,
              },
            },
          }
        );
      }
    }

    invite.status = action === "accept" ? "accepted" : "declined";
    await invite.save();

    if (action === "accept") {
      await User.findByIdAndUpdate(req.userId, {
        $inc: {
          "stats.acceptedChallenges": 1,
          "stats.matchesAccepted": 1,
        },
      });
    } else {
      await User.findByIdAndUpdate(req.userId, {
        $inc: {
          "stats.declinedChallenges": 1,
          "stats.matchesRefused": 1,
        },
      });
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

    if (String(invite.status || "").toLowerCase() !== "pending") {
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
