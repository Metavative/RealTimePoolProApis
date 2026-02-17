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

function isCompletedStatus(status) {
  return normUpper(status, "DRAFT") === "COMPLETED";
}

function isEntriesClosed(t) {
  return normUpper(t?.entriesStatus, "OPEN") === "CLOSED";
}

function isFormatFinalised(t) {
  return normUpper(t?.formatStatus, "DRAFT") === "FINALISED";
}

function isLockedForRoster(t) {
  // Roster/entrants/invites must be locked if any of these apply
  if (!t) return false;
  if (isActiveStatus(t.status) || isCompletedStatus(t.status)) return true;
  if (isEntriesClosed(t)) return true;
  if (isFormatFinalised(t)) return true;
  return false;
}

function rosterLockMessage(t) {
  if (isActiveStatus(t.status) || isCompletedStatus(t.status)) return "Tournament already started";
  if (isFormatFinalised(t)) return "Tournament format is finalised. Entrants are locked.";
  if (isEntriesClosed(t)) return "Entries are closed for this tournament";
  return "Tournament is locked";
}

function lockStatusCode() {
  // Use 409 Conflict for state-based lockouts
  return 409;
}

// -------------------------
// Match generation helpers (schema-aligned)
// -------------------------
function buildEntrantIndex(t) {
  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  const byKey = new Map();
  for (const e of entrants) {
    const pk = String(e?.participantKey || "").trim();
    if (!pk) continue;
    const name =
      String(e?.name || "").trim() ||
      String(e?.username || "").trim() ||
      pk;
    byKey.set(pk, { name, username: String(e?.username || "").trim() });
  }
  return byKey;
}

function pickParticipantKeysFromTournament(t) {
  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  return entrants
    .map((e) => String(e?.participantKey || "").trim())
    .filter(Boolean);
}

function shuffleCopy(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeMatch({ id, teamA, teamB, venue, entrantIndex }) {
  const aKey = String(teamA || "").trim();
  const bKey = String(teamB || "").trim();

  const aName =
    aKey.toUpperCase() === "BYE"
      ? "BYE"
      : (entrantIndex.get(aKey)?.name || "");
  const bName =
    bKey.toUpperCase() === "BYE"
      ? "BYE"
      : (entrantIndex.get(bKey)?.name || "");

  return {
    id: String(id || "").trim(),
    teamA: aKey,
    teamB: bKey,
    teamAName: String(aName || "").trim(),
    teamBName: String(bName || "").trim(),
    venue: String(venue || "").trim(),
    dateTime: null,
    scoreA: 0,
    scoreB: 0,
    status: "scheduled",
    // teamAId / teamBId left null (only used if your keys are uid:<ObjectId>)
    teamAId: null,
    teamBId: null,
  };
}

function rrMatches(keys, venue, entrantIndex) {
  const out = [];
  let counter = 1;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      out.push(
        makeMatch({
          id: `rr_${counter++}`,
          teamA: keys[i],
          teamB: keys[j],
          venue,
          entrantIndex,
        })
      );
    }
  }
  return out;
}

function koMatches(keys, venue, entrantIndex) {
  const shuffled = shuffleCopy(keys);
  const out = [];
  let counter = 1;

  for (let i = 0; i < shuffled.length; i += 2) {
    const a = shuffled[i];
    const b = i + 1 < shuffled.length ? shuffled[i + 1] : "BYE";
    out.push(
      makeMatch({
        id: `ko_${counter++}`,
        teamA: a,
        teamB: b,
        venue,
        entrantIndex,
      })
    );
  }
  return out;
}

// ✅ Minimal valid double elimination: generate Winners Bracket Round 1.
// This guarantees matches are persisted and never disappear after reload.
function deMatchesWinnersR1(keys, venue, entrantIndex) {
  const shuffled = shuffleCopy(keys);
  const out = [];
  let counter = 1;

  for (let i = 0; i < shuffled.length; i += 2) {
    const a = shuffled[i];
    const b = i + 1 < shuffled.length ? shuffled[i + 1] : "BYE";
    out.push(
      makeMatch({
        id: `de_wb_r1_${counter++}`,
        teamA: a,
        teamB: b,
        venue,
        entrantIndex,
      })
    );
  }

  return out;
}

function groupStageMatchesFromGroups(t, venue, entrantIndex) {
  const gs = Array.isArray(t.groups) ? t.groups : [];
  if (!gs.length) {
    const err = new Error("Groups not found. Generate groups first.");
    err.statusCode = 400;
    throw err;
  }

  const out = [];
  for (const g of gs) {
    const gidRaw = String(g?.id || "").trim();
    const gid = gidRaw || "A";

    const members = Array.isArray(g?.members) ? g.members : [];
    const cleanMembers = members.map((m) => String(m || "").trim()).filter(Boolean);

    let counter = 1;
    for (let i = 0; i < cleanMembers.length; i++) {
      for (let j = i + 1; j < cleanMembers.length; j++) {
        out.push(
          makeMatch({
            id: `g_${gid}_${counter++}`,
            teamA: cleanMembers[i],
            teamB: cleanMembers[j],
            venue,
            entrantIndex,
          })
        );
      }
    }
  }
  return out;
}

async function persistMatches(tournamentDoc, matches) {
  tournamentDoc.matches = Array.isArray(matches) ? matches : [];
  tournamentDoc.markModified("matches");
  await tournamentDoc.save();
  return await Tournament.findById(tournamentDoc._id);
}

// -------------------------
// POST /api/tournaments
// club-only
// -------------------------
export async function create(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const title = String(req.body.title || req.body.name || "").trim();
    const format = String(req.body.format || "group_stage").trim();

    const accessMode = normUpper(req.body.accessMode, "OPEN");
    const entriesStatus = normUpper(req.body.entriesStatus, "OPEN");

    const groupCount =
      req.body.groupCount != null ? parseInt(req.body.groupCount, 10) : undefined;
    const topNPerGroup =
      req.body.topNPerGroup != null ? parseInt(req.body.topNPerGroup, 10) : undefined;

    const groupRandomize =
      req.body.groupRandomize != null ? !!req.body.groupRandomize : undefined;

    const playoffDefaultVenue = String(
      req.body.playoffDefaultVenue || req.body.defaultVenue || ""
    ).trim();

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
      // closedAt/closedBy default null in schema
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
// club-only
// -------------------------
export async function patch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status title format");
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
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
// -------------------------
export async function patchSettings(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const tournament = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status accessMode entriesStatus formatStatus format groupCount topNPerGroup groupRandomize playoffDefaultVenue formatConfig closedAt closedBy"
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
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
    }

    // accessMode
    if (req.body.accessMode != null) {
      const next = normUpper(req.body.accessMode, "");
      if (!["OPEN", "INVITE_ONLY"].includes(next)) {
        return res.status(400).json({ message: "Invalid accessMode" });
      }
      if (entriesClosed || formatFinalised) {
        return res.status(lockStatusCode()).json({
          message: formatFinalised
            ? "Tournament format is finalised. Settings locked."
            : "Entries are closed for this tournament",
        });
      }
      tournament.accessMode = next;
    }

    // entriesStatus (ALLOW ONLY OPEN HERE; close via endpoint)
    if (req.body.entriesStatus != null) {
      const next = normUpper(req.body.entriesStatus, "");
      if (!["OPEN", "CLOSED"].includes(next)) {
        return res.status(400).json({ message: "Invalid entriesStatus" });
      }
      if (next === "OPEN") {
        if (formatFinalised) {
          return res
            .status(lockStatusCode())
            .json({ message: "Tournament format is finalised. Entrants are locked." });
        }
        tournament.entriesStatus = "OPEN";
        tournament.closedAt = null;
        tournament.closedBy = null;
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

    if ((entriesClosed || formatFinalised) && hasFormatSettingsChange) {
      return res.status(lockStatusCode()).json({
        message: formatFinalised
          ? "Tournament format is finalised. Settings locked."
          : "Entries are closed for this tournament",
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
      "clubId status entriesStatus formatStatus closedAt closedBy"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";

    if (isActive || isCompleted) {
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
    }

    if (isFormatFinalised(tournament)) {
      // Still allow closing if finalised? Usually already locked, but safe:
      // return 200 as no-op, or 409. We'll return 200 and ensure entriesStatus is CLOSED.
    }

    if (normUpper(tournament.entriesStatus, "OPEN") === "CLOSED") {
      return res.status(200).json({ message: "Entries already closed", data: tournament });
    }

    tournament.entriesStatus = "CLOSED";
    tournament.closedAt = new Date();
    tournament.closedBy = req.clubId;

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
      "clubId status entriesStatus formatStatus closedAt closedBy"
    );
    if (!tournament) return;

    const status = normUpper(tournament.status, "DRAFT");
    const isActive = isActiveStatus(status);
    const isCompleted = status === "COMPLETED";

    if (isActive || isCompleted) {
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
    }

    if (isFormatFinalised(tournament)) {
      return res
        .status(lockStatusCode())
        .json({ message: "Tournament format is finalised. Entrants are locked." });
    }

    if (normUpper(tournament.entriesStatus, "OPEN") === "OPEN") {
      return res.status(200).json({ message: "Entries already open", data: tournament });
    }

    tournament.entriesStatus = "OPEN";
    tournament.closedAt = null;
    tournament.closedBy = null;

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

    const t = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
    }

    // If you want to force close entries when finalising (recommended), uncomment:
    // t.entriesStatus = "CLOSED";
    // t.closedAt = t.closedAt || new Date();
    // t.closedBy = t.closedBy || req.clubId;

    t.formatStatus = "FINALISED";
    await t.save();

    return res.status(200).json({ message: "Format finalised", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to finalise format" });
  }
}

// -------------------------
// POST /api/tournaments/:id/entrants
// -------------------------
export async function setEntrants(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    // ✅ Enforce roster locks here (critical)
    const lockCheck = await loadOwnedTournament(
      req,
      res,
      id,
      "clubId status entriesStatus formatStatus"
    );
    if (!lockCheck) return;

    if (isLockedForRoster(lockCheck)) {
      return res.status(lockStatusCode()).json({ message: rosterLockMessage(lockCheck) });
    }

    const entrants = req.body?.entrants;
    const entrantIds = req.body?.entrantIds;

    if (Array.isArray(entrants) && entrants.length && typeof entrants[0] === "object") {
      const t = await svc.setEntrantsObjects(id, entrants);
      return res.status(200).json({ message: "Entrants saved", data: t });
    }

    const ids = Array.isArray(entrantIds) ? entrantIds : entrants;
    if (!Array.isArray(ids) || ids.length < 2) {
      return res
        .status(400)
        .json({ message: "Provide entrants (objects) or entrantIds (min 2)" });
    }

    const t = await svc.setEntrants(id, ids);
    return res.status(200).json({ message: "Entrants saved", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to set entrants" });
  }
}

// -------------------------
// POST /api/tournaments/:id/groups/generate
// -------------------------
export async function generateGroups(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    // If format/entries are locked, don't allow regenerating groups
    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus");
    if (!t0) return;

    if (isLockedForRoster(t0)) {
      return res.status(lockStatusCode()).json({ message: rosterLockMessage(t0) });
    }

    const groupCount =
      req.body?.groupCount != null ? parseInt(req.body.groupCount, 10) : undefined;
    const groupSize =
      req.body?.groupSize != null ? parseInt(req.body.groupSize, 10) : undefined;
    const randomize = req.body?.randomize != null ? !!req.body.randomize : undefined;

    const t = await svc.generateGroupsSeeded(id, { groupCount, groupSize, randomize });
    return res.status(200).json({ message: "Groups generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate groups" });
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate-group
// -------------------------
export async function generateGroupMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t0 = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus");
    if (!t0) return;

    if (isLockedForRoster(t0)) {
      return res.status(lockStatusCode()).json({ message: rosterLockMessage(t0) });
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generateGroupMatches(id, { defaultVenue });
    return res.status(200).json({ message: "Group matches generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate group matches" });
  }
}

// -------------------------
// POST /api/tournaments/:id/matches/generate
// ✅ FIX: Controller guarantees persistence + supports double_elim.
// -------------------------
export async function generateMatches(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const { id } = req.params;

    const t = await loadOwnedTournament(req, res, id, "clubId status entriesStatus formatStatus entrants groups format matches");
    if (!t) return;

    // Generating matches is a "format action"—lock it when entries closed or finalised
    if (isLockedForRoster(t)) {
      return res.status(lockStatusCode()).json({ message: rosterLockMessage(t) });
    }

    const format = String(req.body?.format || t.format || "").trim();
    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    if (!format) {
      return res.status(400).json({ message: "Missing format" });
    }

    const keys = pickParticipantKeysFromTournament(t);
    if (keys.length < 2) {
      return res
        .status(400)
        .json({ message: "Need at least 2 entrants before generating matches" });
    }

    const entrantIndex = buildEntrantIndex(t);

    let matches = [];
    if (format === "round_robin") {
      matches = rrMatches(keys, defaultVenue, entrantIndex);
    } else if (format === "knockout") {
      matches = koMatches(keys, defaultVenue, entrantIndex);
    } else if (format === "group_stage") {
      matches = groupStageMatchesFromGroups(t, defaultVenue, entrantIndex);
    } else if (format === "double_elim") {
      matches = deMatchesWinnersR1(keys, defaultVenue, entrantIndex);
    } else {
      matches = rrMatches(keys, defaultVenue, entrantIndex);
    }

    const saved = await persistMatches(t, matches);
    return res.status(200).json({ message: "Matches generated", data: saved });
  } catch (e) {
    const sc = e?.statusCode || 500;
    return res.status(sc).json({ message: e?.message || "Failed to generate matches" });
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

    if (isLockedForRoster(t0)) {
      return res.status(lockStatusCode()).json({ message: rosterLockMessage(t0) });
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const t = await svc.generatePlayoffs(id, { defaultVenue });
    return res.status(200).json({ message: "Playoffs generated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to generate playoffs" });
  }
}

// -------------------------
// PATCH /api/tournaments/:id/matches
// -------------------------
export async function upsertMatch(req, res) {
  try {
    if (!requireClub(req, res)) return;

    // Editing a match after start is allowed in your flow (score entry).
    // So we do NOT block on status here.
    const { id } = req.params;
    const t = await svc.upsertMatch(id, req.body);
    return res.status(200).json({ message: "Match updated", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to update match" });
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
      "clubId status startedAt entriesStatus formatStatus"
    );
    if (!t) return;

    const status = normUpper(t.status, "DRAFT");
    if (isActiveStatus(status) || status === "COMPLETED") {
      return res.status(lockStatusCode()).json({ message: "Tournament already started" });
    }

    // Recommended: must have entries closed OR format finalised before start
    // If you want to enforce it, uncomment below:
    // if (!isEntriesClosed(t) && !isFormatFinalised(t)) {
    //   return res.status(400).json({ message: "Close entries or finalise format before starting" });
    // }

    t.status = "ACTIVE";
    t.startedAt = new Date();
    await t.save();

    return res.status(200).json({ message: "Tournament started", data: t });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to start tournament" });
  }
}
