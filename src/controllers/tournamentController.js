import Tournament from "../models/tournament.model.js";
import * as svc from "../services/tournament.service.js";

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
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });
    return res.json({ ok: true, data: t });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export async function patch(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

    const body = req.body || {};
    const allowed = ["title", "format", "groupCount", "groupSize", "groupRandomize", "topNPerGroup"];

    for (const k of allowed) {
      if (body[k] !== undefined) t[k] = body[k];
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
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

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

// --- Entrants ---
export async function setEntrants(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

    if (t.entriesStatus === "CLOSED") {
      return res.status(403).json({ ok: false, message: "Entries are closed for this tournament" });
    }

    const ids = req.body?.entrantIds;
    if (!Array.isArray(ids)) return res.status(400).json({ ok: false, message: "entrantIds must be an array" });

    const updated = await svc.setEntrants(t._id, ids);
    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Seeded groups (balanced) ---
export async function generateGroups(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

    const { groupCount, groupSize, randomize } = req.body || {};

    const updated = await svc.generateGroupsSeeded(t._id, {
      groupCount: groupCount ?? t.groupCount,
      groupSize: groupSize ?? t.groupSize,
      randomize: randomize ?? false, // best UX: default false
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
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

    const defaultVenue = String(req.body?.defaultVenue || "").trim();
    const updated = await svc.generateGroupMatches(t._id, { defaultVenue });

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

// --- Generate playoffs (with auto-progress BYEs) ---
export async function generatePlayoffs(req, res) {
  try {
    const clubId = req.clubId;
    const t = await Tournament.findOne({ _id: req.params.id, clubId });
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

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
    if (!t) return res.status(404).json({ ok: false, message: "Tournament not found" });

    const matchUpdate = req.body;
    const updated = await svc.upsertMatch(t._id, matchUpdate);

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}
