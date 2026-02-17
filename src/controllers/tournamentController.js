import Tournament from "../models/tournament.model.js";

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
  const s = String(v ?? fallback ?? "").trim().toUpperCase();
  return s;
}

function isActiveStatus(status) {
  const s = normUpper(status, "DRAFT");
  return s === "ACTIVE" || s === "LIVE";
}

// -------------------------
// PATCH /api/tournaments/:id/settings
// club-only
// body: { accessMode?, entriesStatus?, groupCount?, topNPerGroup?, groupRandomize?, playoffDefaultVenue?, formatConfig? }
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

      // lock access changes once entries closed / format finalised
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
    // CLOSED should be done via /entries/close endpoint.
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

    // ---- format-related settings are locked once entries closed or format finalised
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
// club-only
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
// club-only
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
