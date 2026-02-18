// src/controllers/tournament.controller.js
import Tournament from "../models/tournament.model.js";
import * as svc from "../services/tournament.service.js";

// -------------------------
// helpers
// -------------------------
function jsonOk(res, data, code = 200, message) {
  const payload = { success: true, data };
  if (message) payload.message = message;
  return res.status(code).json(payload);
}

function jsonErr(res, message, code = 400, extra = {}) {
  return res.status(code).json({ success: false, message, ...extra });
}

function requireClub(req, res) {
  if (req.authType !== "club" || !req.clubId || !req.club) {
    jsonErr(res, "Club authorization required", 403);
    return false;
  }
  return true;
}

async function loadOwnedTournament(req, res, id, select = "") {
  const t = await Tournament.findById(id).select(select || "");
  if (!t) {
    jsonErr(res, "Tournament not found", 404);
    return null;
  }
  if (t.clubId && String(t.clubId) !== String(req.clubId)) {
    jsonErr(res, "Not allowed for this tournament", 403);
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

function isEntriesClosed(t) {
  return normUpper(t?.entriesStatus, "OPEN") === "CLOSED";
}

function isFormatFinalised(t) {
  return normUpper(t?.formatStatus, "DRAFT") === "FINALISED";
}

function lockStatusCode() {
  return 409;
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// -------------------------
// POST /api/tournaments
// -------------------------
export async function create(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const title = String(req.body.title || req.body.name || "").trim();
    const format = String(req.body.format || "group_stage").trim();

    const accessMode = normUpper(req.body.accessMode, "INVITE_ONLY");
    const entriesStatus = normUpper(req.body.entriesStatus, "OPEN");

    const groupCount =
      req.body.groupCount != null ? toInt(req.body.groupCount, undefined) : undefined;

    const topNPerGroup =
      req.body.topNPerGroup != null ? toInt(req.body.topNPerGroup, undefined) : undefined;

    const groupRandomize =
      req.body.groupRandomize != null ? !!req.body.groupRandomize : undefined;

    const groupBalanced =
      req.body.groupBalanced != null ? !!req.body.groupBalanced : undefined;

    const enableKnockoutStage =
      req.body.enableKnockoutStage != null ? !!req.body.enableKnockoutStage : undefined;

    const defaultVenue = String(req.body.defaultVenue || "").trim();
    const playoffDefaultVenue = String(req.body.playoffDefaultVenue || defaultVenue || "").trim();

    const t = await Tournament.create({
      clubId: req.clubId,
      title,
      format,
      accessMode,
      entriesStatus,

      defaultVenue,
      playoffDefaultVenue,

      groupCount: Number.isFinite(groupCount) ? groupCount : undefined,
      topNPerGroup: Number.isFinite(topNPerGroup) ? topNPerGroup : undefined,

      ...(groupRandomize != null ? { groupRandomize } : {}),
      ...(groupBalanced != null ? { groupBalanced } : {}),
      ...(enableKnockoutStage != null ? { enableKnockoutStage } : {}),
    });

    return jsonOk(res, t, 201, "Tournament created");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to create tournament", 500);
  }
}

// -------------------------
// GET /api/tournaments/my  (and GET /api/tournaments/ via routes)
// -------------------------
export async function listMine(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const list = await Tournament.find({ clubId: req.clubId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return jsonOk(res, list);
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to list tournaments", 500);
  }
}

// -------------------------
// GET /api/tournaments/:id
// -------------------------
export async function getOne(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const t = await loadOwnedTournament(req, res, id);
    if (!t) return;

    return jsonOk(res, t);
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to get tournament", 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id
// -------------------------
export async function patch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status title format");
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    if (req.body.title != null) t.title = String(req.body.title || "").trim();
    if (req.body.format !=null) t.format = String(req.body.format || "").trim();

    await t.save();
    return jsonOk(res, t, 200, "Tournament updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to patch tournament", 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id/settings
// -------------------------
export async function patchSettings(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status accessMode entriesStatus formatStatus format groupCount topNPerGroup groupRandomize groupBalanced enableKnockoutStage defaultVenue playoffDefaultVenue formatConfig closedAt closedBy"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const entriesStatus = normUpper(tournament.entriesStatus, "OPEN");
    const formatStatus = normUpper(tournament.formatStatus, "DRAFT");

    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";
    const entriesClosed = entriesStatus === "CLOSED";
    const formatFinalised = formatStatus === "FINALISED";

    if (isActive || isCompleted) {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    // accessMode
    if (req.body.accessMode != null) {
      const next = normUpper(req.body.accessMode, "");
      if (!["OPEN", "INVITE_ONLY"].includes(next)) {
        return jsonErr(res, "Invalid accessMode", 400);
      }
      if (entriesClosed || formatFinalised) {
        return jsonErr(
          res,
          formatFinalised
            ? "Tournament format is finalised. Settings locked."
            : "Entries are closed for this tournament",
          lockStatusCode()
        );
      }
      tournament.accessMode = next;
    }

    // entriesStatus (ALLOW ONLY OPEN HERE; close via endpoint)
    if (req.body.entriesStatus != null) {
      const next = normUpper(req.body.entriesStatus, "");
      if (!["OPEN", "CLOSED"].includes(next)) {
        return jsonErr(res, "Invalid entriesStatus", 400);
      }
      if (next === "OPEN") {
        if (formatFinalised) {
          return jsonErr(
            res,
            "Tournament format is finalised. Entrants are locked.",
            lockStatusCode()
          );
        }
        tournament.entriesStatus = "OPEN";
        tournament.closedAt = null;
        tournament.closedBy = null;
      } else {
        return jsonErr(res, "Use /entries/close endpoint to close entries", 400);
      }
    }

    const hasFormatSettingsChange =
      req.body.groupCount != null ||
      req.body.topNPerGroup != null ||
      req.body.groupRandomize != null ||
      req.body.groupBalanced != null ||
      req.body.enableKnockoutStage != null ||
      req.body.defaultVenue != null ||
      req.body.playoffDefaultVenue != null ||
      req.body.formatConfig != null;

    if ((entriesClosed || formatFinalised) && hasFormatSettingsChange) {
      return jsonErr(
        res,
        formatFinalised
          ? "Tournament format is finalised. Settings locked."
          : "Entries are closed for this tournament",
        lockStatusCode()
      );
    }

    if (req.body.groupCount != null) {
      const v = toInt(req.body.groupCount, NaN);
      if (Number.isNaN(v) || v < 2) return jsonErr(res, "Invalid groupCount", 400);
      tournament.groupCount = v;
    }

    if (req.body.topNPerGroup != null) {
      const v = toInt(req.body.topNPerGroup, NaN);
      if (Number.isNaN(v) || v < 1) return jsonErr(res, "Invalid topNPerGroup", 400);
      tournament.topNPerGroup = v;
    }

    if (req.body.groupRandomize != null) tournament.groupRandomize = !!req.body.groupRandomize;
    if (req.body.groupBalanced != null) tournament.groupBalanced = !!req.body.groupBalanced;
    if (req.body.enableKnockoutStage != null)
      tournament.enableKnockoutStage = !!req.body.enableKnockoutStage;

    if (req.body.defaultVenue != null) {
      tournament.defaultVenue = String(req.body.defaultVenue || "").trim();
    }

    if (req.body.playoffDefaultVenue != null) {
      tournament.playoffDefaultVenue = String(req.body.playoffDefaultVenue || "").trim();
    }

    if (req.body.formatConfig != null && typeof req.body.formatConfig === "object") {
      tournament.formatConfig = req.body.formatConfig;
    }

    await tournament.save();
    return jsonOk(res, tournament, 200, "Settings updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to patch settings", 500);
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
      "clubId status entriesStatus formatStatus closedAt closedBy"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    if (normUpper(tournament.entriesStatus, "OPEN") === "CLOSED") {
      return jsonOk(res, tournament, 200, "Entries already closed");
    }

    tournament.entriesStatus = "CLOSED";
    tournament.closedAt = new Date();
    tournament.closedBy = req.clubId;

    await tournament.save();
    return jsonOk(res, tournament, 200, "Entries closed");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to close entries", 500);
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
      "clubId status entriesStatus formatStatus closedAt closedBy"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    if (isFormatFinalised(tournament)) {
      return jsonErr(
        res,
        "Tournament format is finalised. Entrants are locked.",
        lockStatusCode()
      );
    }

    if (normUpper(tournament.entriesStatus, "OPEN") === "OPEN") {
      return jsonOk(res, tournament, 200, "Entries already open");
    }

    tournament.entriesStatus = "OPEN";
    tournament.closedAt = null;
    tournament.closedBy = null;

    await tournament.save();
    return jsonOk(res, tournament, 200, "Entries opened");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to open entries", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/finalise
// -------------------------
export async function finaliseFormat(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    // ✅ Enforce step order
    if (!isEntriesClosed(t)) {
      return jsonErr(res, "Close entries first", 400);
    }

    t.formatStatus = "FINALISED";
    await t.save();

    return jsonOk(res, t, 200, "Format finalised");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to finalise format", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/entrants
// -------------------------
export async function setEntrants(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const lockCheck = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!lockCheck) return;

    // roster lock
    const locked =
      normUpper(lockCheck.status, "DRAFT") === "ACTIVE" ||
      normUpper(lockCheck.status, "DRAFT") === "COMPLETED" ||
      isEntriesClosed(lockCheck) ||
      isFormatFinalised(lockCheck);

    if (locked) {
      return jsonErr(
        res,
        isFormatFinalised(lockCheck)
          ? "Tournament format is finalised. Entrants are locked."
          : isEntriesClosed(lockCheck)
          ? "Entries are closed for this tournament"
          : "Tournament already started",
        lockStatusCode()
      );
    }

    const entrants = req.body?.entrants;
    const entrantIds = req.body?.entrantIds;

    if (Array.isArray(entrants) && entrants.length && typeof entrants[0] === "object") {
      const t = await svc.setEntrantsObjects(id, entrants);
      return jsonOk(res, t, 200, "Entrants saved");
    }

    const ids = Array.isArray(entrantIds) ? entrantIds : entrants;
    if (!Array.isArray(ids) || ids.length < 2) {
      return jsonErr(res, "Provide entrants (objects) or entrantIds (min 2)", 400);
    }

    const t = await svc.setEntrants(id, ids);
    return jsonOk(res, t, 200, "Entrants saved");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to set entrants", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/groups/generate
// -------------------------
export async function generateGroups(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus");
    if (!t0) return;

    const locked =
      isActiveStatus(t0.status) ||
      normUpper(t0.status, "DRAFT") === "COMPLETED" ||
      isEntriesClosed(t0) ||
      isFormatFinalised(t0);

    if (locked) {
      return jsonErr(res, "Tournament is locked", lockStatusCode());
    }

    const groupCount =
      req.body?.groupCount != null ? toInt(req.body.groupCount, undefined) : undefined;
    const groupSize =
      req.body?.groupSize != null ? toInt(req.body.groupSize, undefined) : undefined;
    const randomize = req.body?.randomize != null ? !!req.body.randomize : undefined;

    const t = await svc.generateGroupsSeeded(id, { groupCount, groupSize, randomize });
    return jsonOk(res, t, 200, "Groups generated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to generate groups", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate-group
// -------------------------
export async function generateGroupMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus defaultVenue");
    if (!t0) return;

    const locked =
      isActiveStatus(t0.status) ||
      normUpper(t0.status, "DRAFT") === "COMPLETED" ||
      isEntriesClosed(t0) ||
      isFormatFinalised(t0);

    if (locked) {
      return jsonErr(res, "Tournament is locked", lockStatusCode());
    }

    const defaultVenue = String(req.body?.defaultVenue || t0.defaultVenue || "").trim();

    const t = await svc.generateGroupMatches(id, { defaultVenue });
    return jsonOk(res, t, 200, "Group matches generated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to generate group matches", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate
// -------------------------
export async function generateMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus format defaultVenue playoffDefaultVenue");
    if (!t0) return;

    const locked =
      isActiveStatus(t0.status) ||
      normUpper(t0.status, "DRAFT") === "COMPLETED" ||
      isEntriesClosed(t0) ||
      isFormatFinalised(t0);

    if (locked) {
      return jsonErr(res, "Tournament is locked", lockStatusCode());
    }

    const format = String(req.body?.format || t0.format || "").trim();
    const defaultVenue = String(
      req.body?.defaultVenue || t0.defaultVenue || t0.playoffDefaultVenue || ""
    ).trim();

    const t = await svc.generateMatchesForFormat(id, { format, defaultVenue });
    return jsonOk(res, t, 200, "Matches generated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to generate matches", e?.statusCode || 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/playoffs/generate
// -------------------------
export async function generatePlayoffs(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus");
    if (!t0) return;

    const locked =
      isActiveStatus(t0.status) ||
      normUpper(t0.status, "DRAFT") === "COMPLETED" ||
      isEntriesClosed(t0) ||
      isFormatFinalised(t0);

    if (locked) {
      return jsonErr(res, "Tournament is locked", lockStatusCode());
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generatePlayoffs(id, { defaultVenue });
    return jsonOk(res, t, 200, "Playoffs generated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to generate playoffs", 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id/matches
// -------------------------
export async function upsertMatch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const t = await svc.upsertMatch(id, req.body); // ✅ service now enforces ACTIVE locks
    return jsonOk(res, t, 200, "Match updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to update match", 500);
  }
}

// -------------------------
// POST /api/tournaments/:id/start
// -------------------------
export async function startTournament(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status startedAt entriesStatus formatStatus format entrants groups matches defaultVenue playoffDefaultVenue"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    const issues = [];

    if (!isEntriesClosed(t)) issues.push("Close entries before starting");
    if (!isFormatFinalised(t)) issues.push("Finalise format before starting");

    const keys = Array.isArray(t.entrants) ? t.entrants.map(e => String(e.participantKey||"").trim()).filter(Boolean) : [];
    if (keys.length < 2) issues.push("Need at least 2 entrants");

    const format = String(t.format || "").trim();
    if (!format) issues.push("Tournament format is missing");

    const hasGroups = Array.isArray(t.groups) && t.groups.length > 0;
    if (format === "group_stage" && !hasGroups) {
      issues.push("Generate groups before starting");
    }

    if (issues.length) {
      return jsonErr(res, "Tournament not ready", 400, { issues });
    }

    // ✅ Ensure matches exist (generate if missing)
    const hasMatches = Array.isArray(t.matches) && t.matches.length > 0;
    if (!hasMatches) {
      const venue = String(t.defaultVenue || t.playoffDefaultVenue || "").trim();
      await svc.generateMatchesForFormat(id, { format, defaultVenue: venue });
    }

    const reloaded = await Tournament.findById(id);
    if (!reloaded) return jsonErr(res, "Tournament not found", 404);

    reloaded.status = "ACTIVE";
    reloaded.startedAt = new Date();
    await reloaded.save();

    return jsonOk(res, reloaded, 200, "Tournament started");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to start tournament", 500);
  }
}
