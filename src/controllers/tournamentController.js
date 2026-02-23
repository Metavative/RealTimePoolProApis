// src/controllers/tournamentController.js
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

function getEntrantKeys(t) {
  const keys = Array.isArray(t?.entrants)
    ? t.entrants
        .map((e) => String(e.participantKey || "").trim())
        .filter(Boolean)
    : [];
  // unique
  return Array.from(new Set(keys));
}

function getConfiguredFormatConfig(t) {
  const fc = t?.formatConfig || {};
  return {
    groupCount: toInt(fc.groupCount, toInt(t.groupCount, 2)),
    qualifiersPerGroup: toInt(fc.qualifiersPerGroup, toInt(t.topNPerGroup, 1)),
    knockoutType: String(fc.knockoutType || "SINGLE_ELIM").trim() || "SINGLE_ELIM",
    thirdPlacePlayoff: !!fc.thirdPlacePlayoff,
    groupRandomize: fc.groupRandomize != null ? !!fc.groupRandomize : !!t.groupRandomize,
    groupBalanced: fc.groupBalanced != null ? !!fc.groupBalanced : !!t.groupBalanced,
    enableKnockoutStage:
      fc.enableKnockoutStage != null ? !!fc.enableKnockoutStage : !!t.enableKnockoutStage,
  };
}

function validateFormatConfig({ groupCount, qualifiersPerGroup }, entrantCount) {
  const issues = [];

  if (!Number.isFinite(groupCount) || groupCount < 1) issues.push("groupCount must be >= 1");
  if (!Number.isFinite(qualifiersPerGroup) || qualifiersPerGroup < 1)
    issues.push("qualifiersPerGroup must be >= 1");

  if (Number.isFinite(groupCount) && groupCount > entrantCount) {
    issues.push("groupCount cannot exceed number of entrants");
  }

  // Must have at least 2 entrants overall
  if (entrantCount < 2) issues.push("Need at least 2 entrants");

  // If groupCount is 1, qualifiersPerGroup cannot exceed entrants
  if (groupCount === 1 && qualifiersPerGroup > entrantCount) {
    issues.push("qualifiersPerGroup cannot exceed entrants");
  }

  // If groupCount > 1, rough sanity: at least one player per group
  if (groupCount > 1 && entrantCount < groupCount) {
    issues.push("Not enough entrants for the selected groupCount");
  }

  // ensure at least 2 qualifiers total if knockout stage is expected
  // (we keep it soft: allow 1 qualifier total if user disables knockout later)
  return issues;
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
// GET /api/tournaments/my
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
    if (req.body.format != null) t.format = String(req.body.format || "").trim();

    await t.save();
    return jsonOk(res, t, 200, "Tournament updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to patch tournament", 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id/settings
// NOTE: formatConfig is now set via /format/configure ONLY
// -------------------------
export async function patchSettings(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status accessMode entriesStatus formatStatus format groupCount topNPerGroup groupRandomize groupBalanced enableKnockoutStage defaultVenue playoffDefaultVenue closedAt closedBy formatConfig"
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
          return jsonErr(res, "Tournament format is finalised. Entrants are locked.", lockStatusCode());
        }
        tournament.entriesStatus = "OPEN";
        tournament.closedAt = null;
        tournament.closedBy = null;
      } else {
        return jsonErr(res, "Use /entries/close endpoint to close entries", 400);
      }
    }

    // Settings that should NOT change after entries are closed OR format finalised
    const hasFormatSettingsChange =
      req.body.groupCount != null ||
      req.body.topNPerGroup != null ||
      req.body.groupRandomize != null ||
      req.body.groupBalanced != null ||
      req.body.enableKnockoutStage != null ||
      req.body.defaultVenue != null ||
      req.body.playoffDefaultVenue != null;

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
      if (Number.isNaN(v) || v < 1) return jsonErr(res, "Invalid groupCount", 400);
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

    // 🚫 Do NOT allow patchSettings to set formatConfig anymore (Step 3 ownership)
    if (req.body.formatConfig != null) {
      return jsonErr(res, "Use /format/configure to set formatConfig", 400);
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
      return jsonErr(res, "Tournament format is finalised. Entrants are locked.", lockStatusCode());
    }

    if (normUpper(tournament.entriesStatus, "OPEN") === "OPEN") {
      return jsonOk(res, tournament, 200, "Entries already open");
    }

    tournament.entriesStatus = "OPEN";
    tournament.closedAt = null;
    tournament.closedBy = null;

    // If organiser re-opens entries, make format flow go back to DRAFT
    // (keeps logic clean, avoids stale configured format)
    tournament.formatStatus = "DRAFT";

    await tournament.save();
    return jsonOk(res, tournament, 200, "Entries opened");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to open entries", 500);
  }
}

// =========================================================
// ✅ STEP 3A: Configure Format
// POST /api/tournaments/:id/format/configure
// =========================================================
export async function configureFormat(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus entrants groupCount topNPerGroup groupRandomize groupBalanced enableKnockoutStage formatConfig"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    // ✅ Allow configuring format while entries are OPEN or CLOSED.
    // Finalise will still require entries to be CLOSED.

    const fStatus = normUpper(t.formatStatus, "DRAFT");
    if (fStatus === "FINALISED") {
      return jsonErr(res, "Tournament format is finalised. Locked.", lockStatusCode());
    }

    const keys = getEntrantKeys(t);
    const entrantCount = keys.length;

    const body = req.body || {};
    const groupCount = toInt(body.groupCount, undefined);
    const qualifiersPerGroup = toInt(body.qualifiersPerGroup, undefined);

    const knockoutType = String(body.knockoutType || "SINGLE_ELIM").trim().toUpperCase();
    const thirdPlacePlayoff = body.thirdPlacePlayoff != null ? !!body.thirdPlacePlayoff : false;

    const groupRandomize = body.groupRandomize != null ? !!body.groupRandomize : t.groupRandomize;
    const groupBalanced = body.groupBalanced != null ? !!body.groupBalanced : t.groupBalanced;
    const enableKnockoutStage =
      body.enableKnockoutStage != null ? !!body.enableKnockoutStage : t.enableKnockoutStage;

    const effectiveGroupCount = Number.isFinite(groupCount) ? groupCount : toInt(t.groupCount, 2);
    const effectiveQualifiers = Number.isFinite(qualifiersPerGroup)
      ? qualifiersPerGroup
      : toInt(t.topNPerGroup, 1);

    const issues = validateFormatConfig(
      { groupCount: effectiveGroupCount, qualifiersPerGroup: effectiveQualifiers },
      entrantCount
    );

    if (!["SINGLE_ELIM"].includes(knockoutType)) {
      issues.push("Invalid knockoutType");
    }

    if (issues.length) {
      return jsonErr(res, "Invalid format configuration", 400, { issues });
    }

    // ✅ Persist to formatConfig (Step 3 canonical)
    t.formatConfig = {
      groupCount: effectiveGroupCount,
      qualifiersPerGroup: effectiveQualifiers,
      knockoutType,
      thirdPlacePlayoff,
      groupRandomize,
      groupBalanced,
      enableKnockoutStage,
    };

    // ✅ Keep legacy fields aligned (services + Flutter already depend on these)
    t.groupCount = effectiveGroupCount;
    t.topNPerGroup = effectiveQualifiers;
    t.groupRandomize = groupRandomize;
    t.groupBalanced = groupBalanced;
    t.enableKnockoutStage = enableKnockoutStage;

    t.formatStatus = "CONFIGURED";
    await t.save();

    return jsonOk(res, t, 200, "Format configured");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to configure format", 500);
  }
}

// =========================================================
// ✅ STEP 3B: Finalise Format (generates groups + matches)
// POST /api/tournaments/:id/format/finalise
// (also used by POST /:id/finalise alias in routes)
// =========================================================
export async function finaliseFormat(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus format entrants groups matches defaultVenue playoffDefaultVenue groupCount topNPerGroup groupRandomize groupBalanced enableKnockoutStage formatConfig championName"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return jsonErr(res, "Tournament already started", lockStatusCode());
    }

    if (!isEntriesClosed(t)) {
      return jsonErr(res, "Close entries first", 400);
    }

    const keys = getEntrantKeys(t);
    if (keys.length < 2) {
      return jsonErr(res, "Need at least 2 entrants", 400);
    }

    const fStatus = normUpper(t.formatStatus, "DRAFT");

    // Backwards compatibility:
    // If still DRAFT, allow finalise to auto-configure from legacy fields once.
    if (fStatus === "DRAFT") {
      const cfg = getConfiguredFormatConfig(t);
      const issues = validateFormatConfig(
        { groupCount: cfg.groupCount, qualifiersPerGroup: cfg.qualifiersPerGroup },
        keys.length
      );
      if (issues.length) return jsonErr(res, "Configure format first", 400, { issues });

      t.formatConfig = {
        groupCount: cfg.groupCount,
        qualifiersPerGroup: cfg.qualifiersPerGroup,
        knockoutType: cfg.knockoutType,
        thirdPlacePlayoff: cfg.thirdPlacePlayoff,
        groupRandomize: cfg.groupRandomize,
        groupBalanced: cfg.groupBalanced,
        enableKnockoutStage: cfg.enableKnockoutStage,
      };
      t.formatStatus = "CONFIGURED";
      await t.save();
    } else if (fStatus === "FINALISED") {
      return jsonOk(res, t, 200, "Format already finalised");
    } else if (fStatus !== "CONFIGURED") {
      return jsonErr(res, "Invalid formatStatus state", 400);
    }

    // Reload after potential auto-config
    const t2 = await Tournament.findById(id);
    if (!t2) return jsonErr(res, "Tournament not found", 404);

    const cfg2 = getConfiguredFormatConfig(t2);
    const issues2 = validateFormatConfig(
      { groupCount: cfg2.groupCount, qualifiersPerGroup: cfg2.qualifiersPerGroup },
      keys.length
    );
    if (issues2.length) {
      return jsonErr(res, "Invalid format configuration", 400, { issues: issues2 });
    }

    // ✅ Deterministic generation happens here:
    // clear generated data first (safe because not active yet)
    t2.groups = [];
    t2.matches = [];
    t2.championName = "";

    // keep legacy aligned again (defensive)
    t2.groupCount = cfg2.groupCount;
    t2.topNPerGroup = cfg2.qualifiersPerGroup;
    t2.groupRandomize = cfg2.groupRandomize;
    t2.groupBalanced = cfg2.groupBalanced;
    t2.enableKnockoutStage = cfg2.enableKnockoutStage;

    await t2.save();

    // Generate groups for group_stage format
    const format = String(t2.format || "").trim();
    const venue = String(t2.defaultVenue || t2.playoffDefaultVenue || "").trim();

    if (format === "group_stage") {
      await svc.generateGroupsSeeded(id, {
        groupCount: cfg2.groupCount,
        groupSize: undefined,
        randomize: cfg2.groupRandomize,
      });
    }

    // Ensure matches exist (group + playoffs as per your existing service behavior)
    await svc.generateMatchesForFormat(id, { format, defaultVenue: venue });

    // Mark finalised last
    const finalReload = await Tournament.findById(id);
    if (!finalReload) return jsonErr(res, "Tournament not found", 404);

    finalReload.formatStatus = "FINALISED";
    await finalReload.save();

    return jsonOk(res, finalReload, 200, "Format finalised");
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

    // ✅ Playoffs generation is allowed during ACTIVE/LIVE after format is FINALISED
    const status = normUpper(t0.status, "DRAFT");
    if (!(status === "ACTIVE" || status === "LIVE")) {
      return jsonErr(res, "Playoffs can only be generated after start", lockStatusCode());
    }
    if (!isFormatFinalised(t0)) {
      return jsonErr(res, "Finalise format first", lockStatusCode());
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();
    const force = req.body?.force === true;

    const t = await svc.generatePlayoffs(id, { defaultVenue, force });
    return jsonOk(res, t, 200, "Playoffs generated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to generate playoffs", e?.statusCode || 500);
  }
}

// -------------------------
// DELETE /api/tournaments/:id/playoffs
// -------------------------
export async function clearPlayoffs(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!t0) return;

    const status = normUpper(t0.status, "DRAFT");
    if (status === "COMPLETED") {
      return jsonErr(res, "Tournament completed", lockStatusCode());
    }

    const t = await svc.clearPlayoffs(id);
    return jsonOk(res, t, 200, "Playoffs cleared");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to clear playoffs", e?.statusCode || 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id/matches (body must include match id)
// -------------------------
export async function upsertMatch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;
    const t = await svc.upsertMatch(id, req.body);
    return jsonOk(res, t, 200, "Match updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to update match", e?.statusCode || 500);
  }
}

// -------------------------
// PATCH /api/tournaments/:id/matches/:matchId (Flutter-friendly: matchId in URL)
// -------------------------
export async function patchMatchById(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id, matchId } = req.params;

    const payload = { ...(req.body || {}), id: String(matchId).trim() };
    const t = await svc.upsertMatch(id, payload);

    return jsonOk(res, t, 200, "Match updated");
  } catch (e) {
    return jsonErr(res, e?.message || "Failed to update match", e?.statusCode || 500);
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

    const keys = getEntrantKeys(t);
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

    const hasMatches = Array.isArray(t.matches) && t.matches.length > 0;
    if (!hasMatches) {
      // Recovery path: regenerate matches even if format is FINALISED,
      // but ONLY because tournament is not started yet.
      await svc.regenerateFinalisedMatchesForStart(id);
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
