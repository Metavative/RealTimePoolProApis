import Tournament from "../models/tournament.model.js";
import * as svc from "../services/tournament.service.js";

// -------------------------
// helpers
// -------------------------
function notReady(res, t, issues) {
  return res.status(409).json({
    ok: false,
    code: "TOURNAMENT_NOT_READY",
    message: "Tournament is not ready",
    issues,
    data: t,
  });
}

export async function create(req, res) {
  try {
    const clubId = req.clubId;

    const body = req.body || {};
    const title = String(body.title || body.name || "").trim();
    const format = body.format || "group_stage";

    const t = await Tournament.create({
      clubId,
      title,
      format,

      // Step 2 defaults
      accessMode: body.accessMode || "INVITE_ONLY", // OPEN | INVITE_ONLY
      entriesStatus: body.entriesStatus || "OPEN", // OPEN | CLOSED
      formatStatus: body.formatStatus || "DRAFT", // DRAFT | FINALISED

      // placeholder for future format wizard
      formatConfig: body.formatConfig || {},
    });

    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function listMine(req, res) {
  try {
    const clubId = req.clubId;

    const items = await Tournament.find({ clubId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    return res.json({ ok: true, data: items });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function getOne(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });
    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function patch(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    // Don’t allow edits after active
    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const body = req.body || {};
    const allowed = [
      "title",
      "format",
      "formatStatus",
      "groupCount",
      "groupSize",
      "groupRandomize",
      "topNPerGroup",
    ];

    for (const k of allowed) {
      if (body[k] !== undefined) t[k] = body[k];
    }

    if (body.formatConfig !== undefined) {
      t.formatConfig = body.formatConfig;
    }

    await t.save();
    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function patchSettings(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const body = req.body || {};
    const allowed = ["accessMode", "entriesStatus"];

    for (const k of allowed) {
      if (body[k] !== undefined) t[k] = body[k];
    }

    await t.save();
    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// -------------------------
// STEP 2: CLOSE ENTRIES
// -------------------------
export async function closeEntries(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    // idempotent
    if (t.entriesStatus === "CLOSED") {
      return res.json({ ok: true, data: t, alreadyClosed: true });
    }

    const issues = [];
    if (!String(t.title || "").trim()) issues.push("Add a tournament title");

    const entrants = Array.isArray(t.entrants) ? t.entrants : [];
    if (entrants.length < 2) issues.push("Add at least 2 players");

    if (issues.length) return notReady(res, t, issues);

    t.entriesStatus = "CLOSED";
    await t.save();

    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// -------------------------
// STEP 3: FINALISE FORMAT
// -------------------------
export async function finaliseFormat(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    // idempotent
    if (t.formatStatus === "FINALISED") {
      return res.json({ ok: true, data: t, alreadyFinalised: true });
    }

    const issues = [];
    if (!String(t.title || "").trim()) issues.push("Add a tournament title");

    const entrants = Array.isArray(t.entrants) ? t.entrants : [];
    if (entrants.length < 2) issues.push("Add at least 2 players");

    if (t.entriesStatus !== "CLOSED") issues.push("Close entries");

    // format-specific minimum checks (keep these minimal)
    if (t.format === "group_stage") {
      if (!Number.isFinite(Number(t.groupCount)) || Number(t.groupCount) < 2) {
        issues.push("Set group count (min 2)");
      }
      if (!Number.isFinite(Number(t.topNPerGroup)) || Number(t.topNPerGroup) < 1) {
        issues.push("Set qualifiers per group (min 1)");
      }
    }

    if (issues.length) return notReady(res, t, issues);

    t.formatStatus = "FINALISED";
    await t.save();

    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Entrants ---
// Accepts either:
//   { entrants: [ {participantKey,name,username,userId,isLocal,...} ] }
// OR legacy:
//   { entrantIds: ["...","..."] }
export async function setEntrants(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    // Organizer must be able to sync entrants until tournament starts
    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const body = req.body || {};

    // NEW: full entrants objects (supports local + app users)
    if (Array.isArray(body.entrants)) {
      const updated = await svc.setEntrantsObjects(t._id, body.entrants);
      return res.json({ ok: true, data: updated });
    }

    // Legacy: entrantIds
    if (Array.isArray(body.entrantIds)) {
      const updated = await svc.setEntrantsByIds(t._id, body.entrantIds);
      return res.json({ ok: true, data: updated });
    }

    return res.status(400).json({
      ok: false,
      message: "Provide either `entrants` (array) or `entrantIds` (array)",
    });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Seeded groups (balanced) ---
export async function generateGroups(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const { groupCount, groupSize, randomize } = req.body || {};

    const updated = await svc.generateGroupsSeeded(t._id, {
      groupCount: groupCount ?? t.groupCount,
      groupSize: groupSize ?? t.groupSize,
      randomize: randomize ?? false,
    });

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Generate matches for any format ---
export async function generateMatches(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();

    const updated = await svc.generateMatchesForFormat(t._id, {
      format: t.format,
      defaultVenue,
    });

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Generate group matches ---
export async function generateGroupMatches(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();
    const updated = await svc.generateGroupMatches(t._id, { defaultVenue });

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Generate playoffs ---
export async function generatePlayoffs(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.status === "ACTIVE") {
      return res.status(403).json({ ok: false, message: "Tournament already started" });
    }

    const defaultVenue = String(req.body?.defaultVenue || "").trim();
    const updated = await svc.generatePlayoffs(t._id, { defaultVenue });

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Update a match result (auto-progress + champion) ---
export async function upsertMatch(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    const matchUpdate = req.body;
    const updated = await svc.upsertMatch(t._id, matchUpdate);

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function startTournament(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t)
      return res.status(404).json({ ok: false, message: "Tournament not found" });

    // idempotent
    if (t.status === "ACTIVE") {
      return res.json({ ok: true, data: t, alreadyStarted: true });
    }
    if (t.status === "COMPLETED") {
      return res.status(400).json({ ok: false, message: "Tournament is already completed" });
    }

    const issues = [];

    if (!String(t.title || "").trim()) issues.push("Add a tournament title");

    const entrants = Array.isArray(t.entrants) ? t.entrants : [];
    if (entrants.length < 2) issues.push("Add at least 2 players");

    if (t.entriesStatus !== "CLOSED") issues.push("Close entries");
    if (t.formatStatus !== "FINALISED") issues.push("Finalise the format");

    const groupsOk = Array.isArray(t.groups) && t.groups.length > 0;
    const matchesOk = Array.isArray(t.matches) && t.matches.length > 0;

    if (t.format === "group_stage") {
      if (!groupsOk) issues.push("Generate groups");
      if (!matchesOk) issues.push("Generate matches");
    } else {
      if (!matchesOk) issues.push("Generate matches");
    }

    if (issues.length) {
      return res.status(409).json({
        ok: false,
        code: "TOURNAMENT_NOT_READY",
        message: "Tournament is not ready to start",
        issues,
        data: t,
      });
    }

    t.status = "ACTIVE";
    t.startedAt = new Date();
    await t.save();

    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}
