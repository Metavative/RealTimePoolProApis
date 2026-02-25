// src/controllers/tournamentController.js
import Tournament from "../models/tournament.model.js";
import * as svc from "../services/tournament.service.js";

// -------------------------
// response helpers
// -------------------------
function ok(res, data) {
  return res.json({ ok: true, data });
}

function fail(res, err) {
  const status = err?.statusCode || err?.status || 500;
  return res.status(status).json({
    ok: false,
    message: err?.message || "Server error",
    issues: err?.issues || undefined,
  });
}

function upper(v, fb = "") {
  return String(v ?? fb).trim().toUpperCase();
}

function getClubId(req) {
  // be defensive: depends on your clubAuthMiddleware
  return (
    req?.club?._id ||
    req?.clubId ||
    req?.club?._id?.toString?.() ||
    req?.user?.clubId ||
    null
  );
}

function assertSameClub(req, tournament) {
  const cid = getClubId(req);
  if (!cid) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  // If your system doesn't tie tournament to clubId yet, you can relax this check.
  // But it’s better to enforce.
  const tClub = tournament?.clubId ? String(tournament.clubId) : "";
  if (tClub && String(cid) !== tClub) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
}

// -------------------------
// basic CRUD
// -------------------------
export async function listMine(req, res) {
  try {
    const cid = getClubId(req);
    if (!cid) {
      const err = new Error("Unauthorized");
      err.statusCode = 401;
      throw err;
    }

    const items = await Tournament.find({ clubId: cid })
      .sort({ createdAt: -1 })
      .lean();

    return ok(res, items);
  } catch (e) {
    return fail(res, e);
  }
}

export async function create(req, res) {
  try {
    const cid = getClubId(req);
    if (!cid) {
      const err = new Error("Unauthorized");
      err.statusCode = 401;
      throw err;
    }

    const format = String(req.body?.format || "round_robin").trim();
    const title = String(req.body?.name || req.body?.title || "").trim();
    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const groupCount = Number(req.body?.groupCount || 2);
    const topNPerGroup = Number(req.body?.topNPerGroup || 1);
    const enableKnockoutStage =
      req.body?.enableKnockoutStage === undefined
        ? true
        : !!req.body.enableKnockoutStage;

    const t = await Tournament.create({
      clubId: cid,
      title,
      format,
      defaultVenue,

      status: "DRAFT",
      accessMode: "INVITE_ONLY",
      entriesStatus: "OPEN",
      formatStatus: "DRAFT",

      // legacy mirrors
      groupCount,
      topNPerGroup,
      enableKnockoutStage,

      // default format config (Step 3)
      formatConfig: {
        groupCount,
        qualifiersPerGroup: topNPerGroup,
        knockoutType: "SINGLE_ELIM",
        thirdPlacePlayoff: false,
        groupRandomize: true,
        groupBalanced: true,
        enableKnockoutStage,
      },
    });

    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

export async function getOne(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

export async function patch(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    // safe patch set
    if (req.body?.title !== undefined) t.title = String(req.body.title || "").trim();
    if (req.body?.defaultVenue !== undefined)
      t.defaultVenue = String(req.body.defaultVenue || "").trim();
    if (req.body?.playoffDefaultVenue !== undefined)
      t.playoffDefaultVenue = String(req.body.playoffDefaultVenue || "").trim();

    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Step 2: access mode
// -------------------------
export async function patchSettings(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const status = upper(t.status, "DRAFT");
    const entriesStatus = upper(t.entriesStatus, "OPEN");
    const formatStatus = upper(t.formatStatus, "DRAFT");

    const rosterLocked =
      status === "ACTIVE" ||
      status === "LIVE" ||
      status === "COMPLETED" ||
      entriesStatus === "CLOSED" ||
      formatStatus === "FINALISED";

    if (rosterLocked) {
      const err = new Error("Tournament is locked");
      err.statusCode = 409;
      throw err;
    }

    if (req.body?.accessMode !== undefined) {
      const next = upper(req.body.accessMode, "INVITE_ONLY");
      if (next !== "OPEN" && next !== "INVITE_ONLY") {
        const err = new Error("Invalid accessMode");
        err.statusCode = 400;
        throw err;
      }
      t.accessMode = next;
    }

    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Step 2: entries open/close
// -------------------------
export async function closeEntries(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const status = upper(t.status, "DRAFT");
    if (status === "ACTIVE" || status === "LIVE" || status === "COMPLETED") {
      const err = new Error("Tournament already started");
      err.statusCode = 409;
      throw err;
    }

    t.entriesStatus = "CLOSED";
    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

export async function openEntries(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const status = upper(t.status, "DRAFT");
    if (status === "ACTIVE" || status === "LIVE" || status === "COMPLETED") {
      const err = new Error("Tournament already started");
      err.statusCode = 409;
      throw err;
    }

    const fs = upper(t.formatStatus, "DRAFT");
    if (fs === "FINALISED") {
      const err = new Error("Format finalised. Re-open entries not allowed.");
      err.statusCode = 409;
      throw err;
    }

    t.entriesStatus = "OPEN";
    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Step 3: configure/finalise format
// -------------------------
export async function configureFormat(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const status = upper(t.status, "DRAFT");
    if (status === "ACTIVE" || status === "LIVE" || status === "COMPLETED") {
      const err = new Error("Tournament already started");
      err.statusCode = 409;
      throw err;
    }

    const fs = upper(t.formatStatus, "DRAFT");
    if (fs === "FINALISED") {
      const err = new Error("Format finalised. Configuration locked.");
      err.statusCode = 409;
      throw err;
    }

    // canonical config
    const groupCount = Math.max(
      1,
      Number(req.body?.groupCount || t.formatConfig?.groupCount || 2)
    );
    const qualifiersPerGroup = Math.max(
      1,
      Number(req.body?.qualifiersPerGroup || t.formatConfig?.qualifiersPerGroup || 1)
    );

    const knockoutType = String(
      req.body?.knockoutType || t.formatConfig?.knockoutType || "SINGLE_ELIM"
    ).trim();

    const thirdPlacePlayoff = !!req.body?.thirdPlacePlayoff;
    const groupRandomize =
      req.body?.groupRandomize === undefined ? true : !!req.body.groupRandomize;
    const groupBalanced =
      req.body?.groupBalanced === undefined ? true : !!req.body.groupBalanced;
    const enableKnockoutStage =
      req.body?.enableKnockoutStage === undefined ? true : !!req.body.enableKnockoutStage;

    t.formatConfig = {
      groupCount,
      qualifiersPerGroup,
      knockoutType,
      thirdPlacePlayoff,
      groupRandomize,
      groupBalanced,
      enableKnockoutStage,
    };

    // keep legacy mirrors aligned for older clients / recovery
    t.groupCount = groupCount;
    t.topNPerGroup = qualifiersPerGroup;
    t.thirdPlacePlayoff = thirdPlacePlayoff;
    t.groupRandomize = groupRandomize;
    t.groupBalanced = groupBalanced;
    t.enableKnockoutStage = enableKnockoutStage;

    t.formatStatus = "CONFIGURED";

    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

export async function finaliseFormat(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t = await Tournament.findById(id);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const status = upper(t.status, "DRAFT");
    if (status === "ACTIVE" || status === "LIVE" || status === "COMPLETED") {
      const err = new Error("Tournament already started");
      err.statusCode = 409;
      throw err;
    }

    const es = upper(t.entriesStatus, "OPEN");
    if (es !== "CLOSED") {
      const err = new Error("Close entries first");
      err.statusCode = 409;
      throw err;
    }

    // For group_stage: require configured
    const fmt = String(t.format || "").trim();
    const fs = upper(t.formatStatus, "DRAFT");
    if (fmt === "group_stage") {
      const cfg = t.formatConfig || {};
      const hasCfg = cfg && Object.keys(cfg).length > 0;
      if (fs === "DRAFT" || !hasCfg) {
        const err = new Error("Configure format first");
        err.statusCode = 409;
        throw err;
      }
    }

    t.formatStatus = "FINALISED";
    await t.save();
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Entrants sync (server truth)
// POST /:id/entrants { entrants: [...] }
// -------------------------
export async function setEntrantsObjects(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(id);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const entrants = Array.isArray(req.body?.entrants) ? req.body.entrants : [];
    const t = await svc.setEntrantsObjects(id, entrants);
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Groups generation (server truth)
// POST /:id/groups/generate
// body: { groupCount, groupSize, randomize }
// -------------------------
export async function generateGroups(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(id);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const groupCount = req.body?.groupCount;
    const groupSize = req.body?.groupSize;
    const randomize = req.body?.randomize;

    const t = await svc.generateGroupsSeeded(id, { groupCount, groupSize, randomize });
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Group matches generation (server truth)
// POST /:id/matches/generate-group { defaultVenue }
// -------------------------
export async function generateGroupMatches(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(id);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const defaultVenue = String(req.body?.defaultVenue || "").trim();
    const t = await svc.generateGroupMatches(id, { defaultVenue });
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Matches generation for non-group formats (server truth)
// POST /:id/matches/generate { format, defaultVenue }
// -------------------------
export async function generateMatchesForFormat(req, res) {
  try {
    const id = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(id);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const format = req.body?.format;
    const defaultVenue = req.body?.defaultVenue;

    const t = await svc.generateMatchesForFormat(id, { format, defaultVenue });
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Patch match (server truth; handles playoffs propagation)
// PATCH /:id/matches body: { id, ...patch }
// -------------------------
export async function patchMatch(req, res) {
  try {
    const tid = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(tid);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const t = await svc.upsertMatch(tid, req.body || {});
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// Playoffs generate / clear (server truth)
// -------------------------
export async function generatePlayoffs(req, res) {
  try {
    const tid = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(tid);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const defaultVenue = req.body?.defaultVenue;
    const force = !!req.body?.force;

    const t = await svc.generatePlayoffs(tid, { defaultVenue, force });
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

export async function clearPlayoffs(req, res) {
  try {
    const tid = String(req.params.id || "").trim();
    const t0 = await Tournament.findById(tid);
    if (!t0) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    assertSameClub(req, t0);

    const t = await svc.clearPlayoffs(tid);
    return ok(res, t);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// START with auto-repair
// POST /:id/start
// -------------------------
export async function startTournament(req, res) {
  try {
    const tid = String(req.params.id || "").trim();

    let t = await Tournament.findById(tid);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    // Must be closed + finalised
    const issues = [];
    if (upper(t.entriesStatus, "OPEN") !== "CLOSED") issues.push("Close entries first");
    if (upper(t.formatStatus, "DRAFT") !== "FINALISED") issues.push("Finalise format first");

    if (issues.length) {
      return res.status(409).json({ ok: false, message: "Tournament not ready", issues });
    }

    // Auto-repair: regenerate missing groups/matches even though finalised
    const fmt = String(t.format || "").trim();
    const isGroup = fmt === "group_stage";

    const hasMatches = Array.isArray(t.matches) && t.matches.length > 0;
    const hasGroups = Array.isArray(t.groups) && t.groups.length > 0;

    if (!hasMatches || (isGroup && !hasGroups)) {
      await svc.regenerateFinalisedMatchesForStart(tid);
      t = await Tournament.findById(tid);
    }

    const hasMatches2 = Array.isArray(t.matches) && t.matches.length > 0;
    const hasGroups2 = Array.isArray(t.groups) && t.groups.length > 0;

    const issues2 = [];
    if (!hasMatches2) issues2.push("Matches are missing");
    if (isGroup && !hasGroups2) issues2.push("Groups are missing");

    if (issues2.length) {
      return res.status(409).json({
        ok: false,
        message: "Tournament not ready",
        issues: issues2,
      });
    }

    // Start
    const st = upper(t.status, "DRAFT");
    if (st === "COMPLETED") {
      const err = new Error("Tournament is completed");
      err.statusCode = 409;
      throw err;
    }
    if (st !== "ACTIVE" && st !== "LIVE") {
      t.status = "ACTIVE";
      await t.save();
    }

    const out = await Tournament.findById(tid);
    return ok(res, out);
  } catch (e) {
    return fail(res, e);
  }
}

// -------------------------
// COMPLETE tournament
// POST /:id/complete
// -------------------------
export async function completeTournament(req, res) {
  try {
    const tid = String(req.params.id || "").trim();

    const t = await Tournament.findById(tid);
    if (!t) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }

    assertSameClub(req, t);

    const st = upper(t.status, "DRAFT");
    if (st === "COMPLETED") {
      // idempotent
      return ok(res, t);
    }

    // optional rule: only allow complete if started
    if (st !== "ACTIVE" && st !== "LIVE") {
      const err = new Error("Tournament must be ACTIVE/LIVE to complete");
      err.statusCode = 409;
      err.issues = ["Start the tournament first"];
      throw err;
    }

    t.status = "COMPLETED";
    t.completedAt = new Date();

    // if you store champion on server, keep it (do not overwrite)
    // if you want to compute champion server-side later, you can add svc helpers here.

    await t.save();

    const out = await Tournament.findById(tid);
    return ok(res, out);
  } catch (e) {
    return fail(res, e);
  }
}