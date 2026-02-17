import Tournament from "../models/tournament.model.js";
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

async function loadOwnedTournament(req, res, id, select = "") {
  const t = await Tournament.findById(id).select(select || "");
  if (!t) {
    res.status(404).json({ message: "Tournament not found" });
    return null;
  }
  if (t.clubId && String(t.clubId) !== String(req.clubId)) {
    res.status(403).json({ message: "Not allowed for this tournament" });
    return null;
  }
  return t;
}

function normUpper(v, fallback) {
  return String(v ?? fallback ?? "").trim().toUpperCase();
}

function isActiveStatus(status) {
  const s = normUpper(status, "DRAFT");
  return s === "ACTIVE" || s === "LIVE";
}

// -------------------------
// POST /api/tournaments
// club-only
// -------------------------
export async function create(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const title = String(req.body.title || req.body.name || "").trim();
    const format = String(req.body.format || "group_stage").trim(); // your service supports group_stage/round_robin/knockout/double_elim

    const accessMode = normUpper(req.body.accessMode, "OPEN");
    const entriesStatus = normUpper(req.body.entriesStatus, "OPEN");

    const groupCount =
      req.body.groupCount != null ? parseInt(req.body.groupCount, 10) : undefined;
    const topNPerGroup =
      req.body.topNPerGroup != null ? parseInt(req.body.topNPerGroup, 10) : undefined;

    const groupRandomize = req.body.groupRandomize != null ? !!req.body.groupRandomize : undefined;

    const playoffDefaultVenue = String(req.body.playoffDefaultVenue || req.body.defaultVenue || "").trim();

    const t = await Tournament.create({
      clubId: req.clubId,
      title,
      format,
      accessMode,
      entriesStatus,
      groupCount: Number.isFinite(groupCount) ? groupCount : undefined,
      topNPerGroup: Number.isFinite(topNPerGroup) ? topNPerGroup : undefined,
      groupRandomize: groupRandomize ?? false,
      playoffDefaultVenue,
      // status/formatStatus handled by schema defaults
    });

    return res.status(201).json({ message: "Tournament created", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to create tournament" });
  }
}

// -------------------------
// GET /api/tournaments/my
// club-only
// -------------------------
export async function listMine(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const list = await Tournament.find({ clubId: req.clubId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({ data: list });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to list tournaments" });
  }
}

// -------------------------
// GET /api/tournaments/:id
// club-only
// -------------------------
export async function getOne(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const t = await loadOwnedTournament(req, res, id);
    if (!t) return;

    return res.status(200).json({ data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to get tournament" });
  }
}

// -------------------------
// PATCH /api/tournaments/:id
// club-only (basic fields)
// -------------------------
export async function patch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status title format");
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    if (req.body.title != null) t.title = String(req.body.title || "").trim();
    if (req.body.format != null) t.format = String(req.body.format || "").trim();

    await t.save();
    return res.status(200).json({ message: "Tournament updated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to patch tournament" });
  }
}

// -------------------------
// PATCH /api/tournaments/:id/settings
// club-only
// (your existing logic; kept and compatible)
// -------------------------
export async function patchSettings(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status accessMode entriesStatus formatStatus format groupCount topNPerGroup groupRandomize playoffDefaultVenue formatConfig"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const entriesStatus = normUpper(tournament.entriesStatus, "OPEN");
    const formatStatus = normUpper(tournament.formatStatus, "DRAFT");

    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";
    const isEntriesClosed = entriesStatus === "CLOSED";
    const isFormatFinalised = formatStatus === "FINALISED";

    if (isActive || isCompleted) {
      return res.status(403).json({ message: "Tournament already started" });
    }

    // ---- accessMode
    if (req.body.accessMode != null) {
      const next = normUpper(req.body.accessMode, "");

      if (!["OPEN", "INVITE_ONLY"].includes(next)) {
        return res.status(400).json({ message: "Invalid accessMode" });
      }

      if (isEntriesClosed || isFormatFinalised) {
        return res.status(403).json({
          message: isFormatFinalised
            ? "Format is finalised. Access mode locked."
            : "Entries are closed. Access mode locked.",
        });
      }

      tournament.accessMode = next;
    }

    // ---- entriesStatus (ALLOW ONLY OPEN HERE)
    if (req.body.entriesStatus != null) {
      const next = normUpper(req.body.entriesStatus, "");
      if (!["OPEN", "CLOSED"].includes(next)) {
        return res.status(400).json({ message: "Invalid entriesStatus" });
      }

      if (next === "OPEN") {
        if (isFormatFinalised) {
          return res
            .status(403)
            .json({ message: "Format is finalised. Re-open entries not allowed." });
        }
        tournament.entriesStatus = "OPEN";
      } else {
        return res.status(400).json({
          message: "Use /entries/close endpoint to close entries",
        });
      }
    }

    const hasFormatSettingsChange =
      req.body.groupCount != null ||
      req.body.topNPerGroup != null ||
      req.body.groupRandomize != null ||
      req.body.playoffDefaultVenue != null ||
      req.body.formatConfig != null;

    if ((isEntriesClosed || isFormatFinalised) && hasFormatSettingsChange) {
      return res.status(403).json({
        message: isFormatFinalised
          ? "Format is finalised. Settings locked."
          : "Entries are closed. Settings locked.",
      });
    }

    if (req.body.groupCount != null) {
      const v = parseInt(req.body.groupCount, 10);
      if (Number.isNaN(v) || v < 2) {
        return res.status(400).json({ message: "Invalid groupCount" });
      }
      tournament.groupCount = v;
    }

    if (req.body.topNPerGroup != null) {
      const v = parseInt(req.body.topNPerGroup, 10);
      if (Number.isNaN(v) || v < 1) {
        return res.status(400).json({ message: "Invalid topNPerGroup" });
      }
      tournament.topNPerGroup = v;
    }

    if (req.body.groupRandomize != null) {
      tournament.groupRandomize = !!req.body.groupRandomize;
    }

    if (req.body.playoffDefaultVenue != null) {
      tournament.playoffDefaultVenue = String(req.body.playoffDefaultVenue || "").trim();
    }

    if (req.body.formatConfig != null && typeof req.body.formatConfig === "object") {
      tournament.formatConfig = req.body.formatConfig;
    }

    await tournament.save();
    return res.status(200).json({ message: "Settings updated", data: tournament });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to patch settings" });
  }
}

// -------------------------
// POST /api/tournaments/:id/entries/close
// -------------------------
export async function closeEntries(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";

    if (isActive || isCompleted) {
      return res.status(403).json({ message: "Tournament already started" });
    }

    tournament.entriesStatus = "CLOSED";
    await tournament.save();

    return res.status(200).json({ message: "Entries closed", data: tournament });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to close entries" });
  }
}

// -------------------------
// POST /api/tournaments/:id/entries/open
// -------------------------
export async function openEntries(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const formatStatus = normUpper(tournament.formatStatus, "DRAFT");

    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";
    const isFormatFinalised = formatStatus === "FINALISED";

    if (isActive || isCompleted) {
      return res.status(403).json({ message: "Tournament already started" });
    }

    if (isFormatFinalised) {
      return res
        .status(403)
        .json({ message: "Format is finalised. Re-open entries not allowed." });
    }

    tournament.entriesStatus = "OPEN";
    await tournament.save();

    return res.status(200).json({ message: "Entries opened", data: tournament });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to open entries" });
  }
}

// -------------------------
// POST /api/tournaments/:id/finalise
// -------------------------
export async function finaliseFormat(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus");
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    t.formatStatus = "FINALISED";
    await t.save();

    return res.status(200).json({ message: "Format finalised", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to finalise format" });
  }
}

// -------------------------
// POST /api/tournaments/:id/entrants
// Accepts:
// - { entrants: [ {participantKey,name,username,userId,isLocal} ] }  -> setEntrantsObjects
// - { entrantIds: [userId...] } or { entrants: [userId...] }         -> setEntrants (seed/rating)
// -------------------------
export async function setEntrants(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const entrants = req.body?.entrants;
    const entrantIds = req.body?.entrantIds;

    // Case A: entrants are objects with participantKey -> store as objects (local + app users)
    if (Array.isArray(entrants) && entrants.length && typeof entrants[0] === "object") {
      const t = await svc.setEntrantsObjects(id, entrants);
      return res.status(200).json({ message: "Entrants saved", data: t });
    }

    // Case B: entrantIds explicitly provided -> setEntrants seeded/rated (your service expects IDs)
    const ids = Array.isArray(entrantIds) ? entrantIds : entrants;
    if (!Array.isArray(ids) || ids.length < 2) {
      return res.status(400).json({ message: "Provide entrants (objects) or entrantIds (min 2)" });
    }

    const t = await svc.setEntrants(id, ids);
    return res.status(200).json({ message: "Entrants saved", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to set entrants" });
  }
}

// -------------------------
// POST /api/tournaments/:id/groups/generate
// Uses your service: generateGroupsSeeded(tid, { groupCount, groupSize, randomize })
// -------------------------
export async function generateGroups(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const groupCount =
      req.body?.groupCount != null ? parseInt(req.body.groupCount, 10) : undefined;

    const groupSize =
      req.body?.groupSize != null ? parseInt(req.body.groupSize, 10) : undefined;

    const randomize = req.body?.randomize != null ? !!req.body.randomize : undefined;

    const t = await svc.generateGroupsSeeded(id, {
      groupCount,
      groupSize,
      randomize,
    });

    return res.status(200).json({ message: "Groups generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate groups" });
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate-group
// Uses your service: generateGroupMatches(tid, { defaultVenue })
// -------------------------
export async function generateGroupMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generateGroupMatches(id, { defaultVenue });
    return res.status(200).json({ message: "Group matches generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate group matches" });
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate
// Uses your service: generateMatchesForFormat(tid, { format, defaultVenue })
// -------------------------
export async function generateMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const format = String(req.body?.format || "").trim();
    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generateMatchesForFormat(id, { format, defaultVenue });
    return res.status(200).json({ message: "Matches generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate matches" });
  }
}

// -------------------------
// POST /api/tournaments/:id/playoffs/generate
// Uses your service: generatePlayoffs(tid, { defaultVenue })
// -------------------------
export async function generatePlayoffs(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generatePlayoffs(id, { defaultVenue });
    return res.status(200).json({ message: "Playoffs generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate playoffs" });
  }
}

// -------------------------
// PATCH /api/tournaments/:id/matches
// Uses your service: upsertMatch(tid, matchUpdate)
// -------------------------
export async function upsertMatch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const t = await svc.upsertMatch(id, req.body);
    return res.status(200).json({ message: "Match updated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to update match" });
  }
}

// -------------------------
// POST /api/tournaments/:id/start
// (your service file doesn't have startTournament, so controller handles it)
// -------------------------
export async function startTournament(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status startedAt");
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(403).json({ message: "Tournament already started" });
    }

    t.status = "ACTIVE";
    t.startedAt = new Date();
    await t.save();

    return res.status(200).json({ message: "Tournament started", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to start tournament" });
  }
}
