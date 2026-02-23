// src/services/tournament.service.js
import Tournament from "../models/tournament.model.js";
import User from "../models/user.model.js";
import { computeUserRating } from "./seedRating.service.js";

// ------------------------------
// small helpers
// ------------------------------
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

/**
 * ✅ HARD roster lock: no entrant changes once:
 * - ACTIVE/LIVE/COMPLETED
 * - entries CLOSED
 * - format FINALISED
 */
function assertRosterMutable(t) {
  const status = normUpper(t?.status, "DRAFT");

  if (isActiveStatus(status) || status === "COMPLETED") {
    const err = new Error("Tournament already started. Entrants are locked.");
    err.statusCode = 409;
    throw err;
  }

  if (isEntriesClosed(t)) {
    const err = new Error("Entries are closed for this tournament");
    err.statusCode = 409;
    throw err;
  }

  if (isFormatFinalised(t)) {
    const err = new Error("Tournament format is finalised. Entrants are locked.");
    err.statusCode = 409;
    throw err;
  }
}

/**
 * Guard: generation ops should not run after ACTIVE/COMPLETED
 */
function assertNotStartedOrCompleted(t) {
  const status = normUpper(t?.status, "DRAFT");
  if (isActiveStatus(status) || status === "COMPLETED") {
    const err = new Error("Tournament already started");
    err.statusCode = 409;
    throw err;
  }
}

/**
 * ✅ Step 2 completion: allow generation after entries CLOSED,
 * but block generation after format FINALISED.
 */
function assertFormatNotFinalised(t) {
  if (isFormatFinalised(t)) {
    const err = new Error("Tournament format is finalised. Generation is locked.");
    err.statusCode = 409;
    throw err;
  }
}

function groupIdFromIndex(idx) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (idx < 26) return letters[idx];
  const first = letters[Math.floor(idx / 26) - 1];
  const second = letters[idx % 26];
  return `${first}${second}`;
}

function isGroupMatchId(id) {
  return String(id || "").startsWith("g_");
}

function isPlayoffMatchId(id) {
  return String(id || "").startsWith("po_");
}

function playoffRoundOf(id) {
  const parts = String(id || "").split("_"); // po, r1, 1
  if (parts.length < 3) return null;
  const r = parts[1];
  if (!r || !r.startsWith("r")) return null;
  const n = parseInt(r.substring(1), 10);
  return Number.isFinite(n) ? n : null;
}

function pkToUserObjectId(participantKey) {
  const s = String(participantKey || "").trim();
  if (!s.startsWith("uid:")) return null;
  const id = s.substring(4).trim();
  return id || null;
}

function pickEntrantName(entrant) {
  return (
    String(entrant?.name || "").trim() ||
    String(entrant?.username || "").trim() ||
    String(entrant?.participantKey || "").trim() ||
    "Player"
  );
}

function makeMatchBase({ id, teamA, teamB, venue, nameByKey }) {
  const a = String(teamA || "").trim();
  const b = String(teamB || "").trim();

  const aName = a.toUpperCase() === "BYE" ? "BYE" : (nameByKey.get(a) || "Player");
  const bName = b.toUpperCase() === "BYE" ? "BYE" : (nameByKey.get(b) || "Player");

  return {
    id: String(id || "").trim(),
    teamA: a,
    teamB: b,
    teamAId: pkToUserObjectId(a),
    teamBId: b.toUpperCase() === "BYE" ? null : pkToUserObjectId(b),
    teamAName: aName,
    teamBName: bName,
    venue: String(venue || "").trim(),
    dateTime: null,
    scoreA: 0,
    scoreB: 0,
    status: "scheduled",
  };
}

// ------------------------------
// Playoffs helpers
// ------------------------------
function playoffWinnerKey(match) {
  const aKey = String(match.teamA || "").trim();
  const bKey = String(match.teamB || "").trim();

  const aBye = aKey.toUpperCase() === "BYE";
  const bBye = bKey.toUpperCase() === "BYE";

  if (aBye && !bBye) return bKey;
  if (bBye && !aBye) return aKey;
  if (aBye && bBye) return null;

  if (match.status !== "played") return null;
  if (match.scoreA === match.scoreB) return null;

  return match.scoreA > match.scoreB ? aKey : bKey;
}

function removePlayoffs(t) {
  t.matches = (t.matches || []).filter((m) => !isPlayoffMatchId(m.id));
  t.championName = "";
}

function clearPlayoffRoundsAfter(t, round) {
  t.matches = (t.matches || []).filter((m) => {
    if (!isPlayoffMatchId(m.id)) return true;
    const r = playoffRoundOf(m.id);
    if (r == null) return true;
    return r <= round;
  });
  t.championName = "";
}

function maxPlayoffRound(t) {
  let maxR = 0;
  for (const m of t.matches || []) {
    if (!isPlayoffMatchId(m.id)) continue;
    const r = playoffRoundOf(m.id);
    if (r && r > maxR) maxR = r;
  }
  return maxR;
}

function recomputeChampion(t) {
  const maxR = maxPlayoffRound(t);
  if (maxR <= 0) {
    t.championName = "";
    return;
  }

  const finals = (t.matches || []).filter(
    (m) => isPlayoffMatchId(m.id) && playoffRoundOf(m.id) === maxR
  );

  if (!finals.length) {
    t.championName = "";
    return;
  }

  finals.sort((a, b) => {
    const sa = parseInt(String(a.id).split("_").pop() || "0", 10);
    const sb = parseInt(String(b.id).split("_").pop() || "0", 10);
    return sa - sb;
  });

  const winners = [];
  for (const m of finals) {
    const w = playoffWinnerKey(m);
    if (!w) {
      t.championName = "";
      return;
    }
    winners.push(w);
  }

  t.championName = winners.length === 1 ? winners[0] : "";
}

function autoProgressFromRound(t, startRound) {
  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  let current = startRound;

  while (true) {
    const roundMatches = (t.matches || []).filter(
      (m) => isPlayoffMatchId(m.id) && playoffRoundOf(m.id) === current
    );

    if (!roundMatches.length) {
      recomputeChampion(t);
      return;
    }

    roundMatches.sort((a, b) => {
      const sa = parseInt(String(a.id).split("_").pop() || "0", 10);
      const sb = parseInt(String(b.id).split("_").pop() || "0", 10);
      return sa - sb;
    });

    const winners = [];
    for (const m of roundMatches) {
      const w = playoffWinnerKey(m);
      if (!w) {
        recomputeChampion(t);
        return;
      }
      winners.push(w);
    }

    if (winners.length < 2) {
      recomputeChampion(t);
      return;
    }

    const nextRound = current + 1;

    const nextExists = (t.matches || []).some(
      (m) => isPlayoffMatchId(m.id) && playoffRoundOf(m.id) === nextRound
    );

    if (nextExists) {
      recomputeChampion(t);
      return;
    }

    const out = [];
    let counter = 1;

    for (let i = 0; i < winners.length; i += 2) {
      const a = winners[i];
      const b = i + 1 < winners.length ? winners[i + 1] : "BYE";

      out.push(
        makeMatchBase({
          id: `po_r${nextRound}_${counter++}`,
          teamA: a,
          teamB: b,
          venue: t.playoffDefaultVenue || "",
          nameByKey,
        })
      );
    }

    t.matches = [...(t.matches || []), ...out];
    current = nextRound;
  }
}

// ------------------------------
// Entrants
// ------------------------------
function normEntrant(e = {}) {
  const participantKey = String(e.participantKey || "").trim();
  if (!participantKey) return null;

  const name = String(e.name || "").trim();
  const username = String(e.username || "").trim();
  const userId = String(e.userId || "").trim();
  const isLocal = !!e.isLocal;

  const entrantId = pkToUserObjectId(participantKey);

  return {
    participantKey,
    entrantId: entrantId || undefined,
    name,
    username,
    userId,
    isLocal,
    rating: 0,
    seed: 0,
  };
}

async function reseedEntrantsFromCurrentList(rawEntrants = []) {
  const clean = [];
  const seen = new Set();

  for (const raw of rawEntrants) {
    const en = normEntrant(raw);
    if (!en) continue;
    if (seen.has(en.participantKey)) continue;
    seen.add(en.participantKey);
    clean.push(en);
  }

  const uidIds = clean
    .map((e) => (e.participantKey || "").startsWith("uid:") ? e.participantKey.substring(4) : "")
    .filter(Boolean);

  let byId = new Map();
  if (uidIds.length) {
    const users = await User.find({ _id: { $in: uidIds } })
      .select("profile.nickname stats.score stats.rank stats.totalWinnings stats.bestWinStreak stats.userIdTag")
      .lean();
    byId = new Map(users.map((u) => [String(u._id), u]));
  }

  for (const e of clean) {
    if (!String(e.participantKey).startsWith("uid:")) {
      e.rating = 0;
      continue;
    }

    const id = String(e.participantKey).substring(4);
    const u = byId.get(String(id));

    if (!e.name) {
      e.name =
        (u?.profile?.nickname && String(u.profile.nickname).trim()) ||
        (u?.stats?.userIdTag && String(u.stats.userIdTag).trim()) ||
        e.name ||
        "Player";
    }

    e.userId = e.userId || String(id);
    e.isLocal = false;
    e.rating = u ? computeUserRating(u) : 0;
    e.entrantId = pkToUserObjectId(e.participantKey) || undefined;
  }

  const seeded = clean.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
  for (let i = 0; i < seeded.length; i++) seeded[i].seed = i + 1;

  return seeded;
}

export async function addEntrantAndReseed(tournamentId, entrantPayload = {}) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertRosterMutable(t);

  const pk = String(entrantPayload.participantKey || "").trim();
  if (!pk) {
    const err = new Error("participantKey is required");
    err.statusCode = 400;
    throw err;
  }

  const entrantIdStr = entrantPayload.entrantId ? String(entrantPayload.entrantId) : "";

  const existing = Array.isArray(t.entrants)
    ? t.entrants.some((e) => {
        const samePk = String(e.participantKey || "").trim() === pk;
        const sameId = entrantIdStr && String(e.entrantId || "").trim() === entrantIdStr;
        return samePk || sameId;
      })
    : false;

  if (existing) return { tournament: t, added: false };

  t.entrants = [
    ...(t.entrants || []),
    {
      entrantId: entrantPayload.entrantId || undefined,
      name: String(entrantPayload.name || "").trim(),
      participantKey: pk,
      username: String(entrantPayload.username || "").trim(),
      userId: String(entrantPayload.userId || "").trim(),
      isLocal: !!entrantPayload.isLocal,
      rating: 0,
      seed: 0,
    },
  ];

  t.entrants = await reseedEntrantsFromCurrentList(t.entrants);

  t.groups = [];
  t.matches = [];
  t.championName = "";

  await t.save();
  return { tournament: t, added: true };
}

export async function setEntrants(tournamentId, entrantIds = []) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertRosterMutable(t);

  const ids = Array.isArray(entrantIds) ? entrantIds : [];
  if (ids.length < 2) throw new Error("Provide entrantIds (min 2)");

  const asKeys = ids
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((v) => {
      if (v.startsWith("uid:") || v.startsWith("un:") || v.startsWith("nm:")) return v;
      return `uid:${v}`;
    });

  t.entrants = await reseedEntrantsFromCurrentList(
    asKeys.map((pk) => ({
      participantKey: pk,
      entrantId: pkToUserObjectId(pk) || undefined,
      name: "",
      username: "",
      userId: pk.startsWith("uid:") ? pk.substring(4) : "",
      isLocal: pk.startsWith("nm:"),
      rating: 0,
      seed: 0,
    }))
  );

  t.groups = [];
  t.matches = [];
  t.championName = "";

  await t.save();
  return t;
}

export async function setEntrantsObjects(tournamentId, entrants = []) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertRosterMutable(t);

  t.entrants = await reseedEntrantsFromCurrentList(entrants);

  t.groups = [];
  t.matches = [];
  t.championName = "";

  await t.save();
  return t;
}

// ------------------------------
// Balanced Groups (snake seeding)
// ------------------------------
export async function generateGroupsSeeded(tournamentId, { groupCount, groupSize, randomize }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ Step 2 completion: entries CLOSED is OK for generation
  assertNotStartedOrCompleted(t);
  assertFormatNotFinalised(t);

  if (!t.entrants || t.entrants.length < 2) throw new Error("Entrants not set");

  const list = t.entrants.slice();
  const n = list.length;

  let count;
  if (groupSize && Number(groupSize) > 0) {
    const sz = Math.max(1, Number(groupSize));
    count = Math.ceil(n / sz);
  } else {
    count = Math.max(2, Number(groupCount || t.groupCount || 2));
    count = Math.min(count, n);
  }

  const seeded = list.slice().sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  if (randomize) seeded.sort(() => Math.random() - 0.5);

  const groups = [];
  for (let i = 0; i < count; i++) {
    const id = groupIdFromIndex(i);
    groups.push({ id, name: `Group ${id}`, members: [] });
  }

  let forward = true;
  let idx = 0;

  while (idx < seeded.length) {
    if (forward) {
      for (let g = 0; g < groups.length && idx < seeded.length; g++) {
        groups[g].members.push(String(seeded[idx].participantKey));
        idx++;
      }
    } else {
      for (let g = groups.length - 1; g >= 0 && idx < seeded.length; g--) {
        groups[g].members.push(String(seeded[idx].participantKey));
        idx++;
      }
    }
    forward = !forward;
  }

  t.groupCount = count;
  t.groupSize = Number(groupSize || t.groupSize || 0);
  t.groupRandomize = Boolean(randomize);

  t.groups = groups;
  t.matches = [];
  t.championName = "";

  await t.save();
  return t;
}

// ------------------------------
// Group matches generation
// ------------------------------
export async function generateGroupMatches(tournamentId, { defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertNotStartedOrCompleted(t);
  assertFormatNotFinalised(t);

  if (t.format !== "group_stage") throw new Error("Tournament is not group_stage");
  if (!t.groups || t.groups.length === 0) throw new Error("Groups not generated");

  t.matches = [];
  t.championName = "";

  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  const matches = [];

  for (const g of t.groups) {
    const members = (g.members || []).map((x) => String(x)).filter(Boolean);
    let counter = 1;

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        matches.push(
          makeMatchBase({
            id: `g_${g.id}_${counter++}`,
            teamA: members[i],
            teamB: members[j],
            venue: defaultVenue || "",
            nameByKey,
          })
        );
      }
    }
  }

  t.matches = matches;
  await t.save();
  return t;
}

// ------------------------------
// Standings
// ------------------------------
function computeGroupStandings(t) {
  const byGroup = new Map();
  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  for (const g of t.groups || []) {
    const rows = new Map();
    for (const pk of g.members || []) {
      const key = String(pk);
      rows.set(key, {
        key,
        name: nameByKey.get(key) || "Player",
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        pts: 0,
        gd: 0,
      });
    }
    byGroup.set(g.id, rows);
  }

  for (const m of t.matches || []) {
    if (!isGroupMatchId(m.id)) continue;
    if (m.status !== "played") continue;

    const parts = String(m.id).split("_");
    if (parts.length < 3) continue;
    const gid = parts[1];

    const groupRows = byGroup.get(gid);
    if (!groupRows) continue;

    const a = groupRows.get(String(m.teamA));
    const b = groupRows.get(String(m.teamB));
    if (!a || !b) continue;

    a.played++;
    b.played++;

    a.gf += m.scoreA;
    a.ga += m.scoreB;

    b.gf += m.scoreB;
    b.ga += m.scoreA;

    if (m.scoreA > m.scoreB) {
      a.won++;
      b.lost++;
      a.pts += 3;
    } else if (m.scoreB > m.scoreA) {
      b.won++;
      a.lost++;
      b.pts += 3;
    } else {
      a.drawn++;
      b.drawn++;
      a.pts += 1;
      b.pts += 1;
    }
  }

  const out = {};
  for (const g of t.groups || []) {
    const rowsMap = byGroup.get(g.id);
    const rows = rowsMap ? Array.from(rowsMap.values()) : [];
    for (const r of rows) r.gd = r.gf - r.ga;

    rows.sort((x, y) => {
      const p = y.pts - x.pts;
      if (p !== 0) return p;
      const gd = y.gd - x.gd;
      if (gd !== 0) return gd;
      const gf = y.gf - x.gf;
      if (gf !== 0) return gf;
      return String(x.name).toLowerCase().localeCompare(String(y.name).toLowerCase());
    });

    out[g.id] = rows;
  }

  return out;
}

/**
 * ✅ Group stage complete when all group matches (g_*) are played.
 */
export async function isGroupStageComplete(tournamentId) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t) throw new Error("Tournament not found");

  const groupMatches = (t.matches || []).filter((m) => isGroupMatchId(m.id));
  if (!groupMatches.length) return false;

  return groupMatches.every((m) => m.status === "played");
}

// ------------------------------
// Playoffs generation (ACTIVE-safe: allowed during ACTIVE/LIVE when format FINALISED)
// ------------------------------
export async function generatePlayoffs(tournamentId, { defaultVenue, force = false }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ Playoffs are a LIVE operation
  const status = normUpper(t.status, "DRAFT");
  if (!(status === "ACTIVE" || status === "LIVE")) {
    const err = new Error("Playoffs can only be generated after the tournament starts");
    err.statusCode = 409;
    throw err;
  }

  if (!isFormatFinalised(t)) {
    const err = new Error("Finalise format before generating playoffs");
    err.statusCode = 409;
    throw err;
  }

  if (t.format !== "group_stage") {
    const err = new Error("Playoffs generation is supported for group_stage only");
    err.statusCode = 400;
    throw err;
  }

  if (!t.groups || t.groups.length === 0) {
    const err = new Error("Groups not generated");
    err.statusCode = 400;
    throw err;
  }

  // ✅ Idempotent by default: if playoffs already exist, do nothing
  const hasPlayoffs = (t.matches || []).some((m) => isPlayoffMatchId(m.id));
  if (hasPlayoffs && !force) return t;

  // If force, wipe and regenerate
  if (hasPlayoffs && force) {
    removePlayoffs(t);
  }

  // Must have group matches
  const hasGroupMatches = (t.matches || []).some((m) => isGroupMatchId(m.id));
  if (!hasGroupMatches) {
    const err = new Error("Group matches missing. Generate group matches first.");
    err.statusCode = 400;
    throw err;
  }

  // Require group stage completion unless forced
  if (!force) {
    const groupMatches = (t.matches || []).filter((m) => isGroupMatchId(m.id));
    const allPlayed =
      groupMatches.length > 0 && groupMatches.every((m) => m.status === "played");
    if (!allPlayed) {
      const err = new Error("Group stage not complete yet");
      err.statusCode = 400;
      throw err;
    }
  }

  // Use venue fallback chain
  const venue = String(
    defaultVenue || t.playoffDefaultVenue || t.defaultVenue || ""
  ).trim();
  t.playoffDefaultVenue = venue;

  // Create playoffs from standings
  const standings = computeGroupStandings(t);
  const qualifiersByGroup = {};

  for (const g of t.groups) {
    const rows = standings[g.id] || [];
    const n = Math.min(Number(t.topNPerGroup || 1), Math.max(0, rows.length));
    qualifiersByGroup[g.id] = rows.slice(0, n);
  }

  const totalQualifiers = Object.values(qualifiersByGroup).reduce(
    (a, b) => a + b.length,
    0
  );
  if (totalQualifiers < 2) {
    await t.save();
    return t;
  }

  const maxN = Object.values(qualifiersByGroup).reduce(
    (m, list) => Math.max(m, list.length),
    0
  );

  const ordered = [];
  for (let r = 0; r < maxN; r++) {
    for (const g of t.groups) {
      const list = qualifiersByGroup[g.id] || [];
      if (r < list.length) ordered.push(String(list[r].key));
    }
  }

  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  const out = [];
  let counter = 1;

  let i = 0;
  let j = ordered.length - 1;
  while (i < j) {
    out.push(
      makeMatchBase({
        id: `po_r1_${counter++}`,
        teamA: ordered[i],
        teamB: ordered[j],
        venue,
        nameByKey,
      })
    );
    i++;
    j--;
  }

  if (i === j) {
    out.push(
      makeMatchBase({
        id: `po_r1_${counter++}`,
        teamA: ordered[i],
        teamB: "BYE",
        venue,
        nameByKey,
      })
    );
  }

  t.matches = [...(t.matches || []), ...out];

  autoProgressFromRound(t, 1);
  await t.save();
  return t;
}

// ------------------------------
// Clear playoffs on server
// ------------------------------
export async function clearPlayoffs(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");
  removePlayoffs(t);
  await t.save();
  return t;
}

// ------------------------------
// Match update (LOCK teams after ACTIVE)
// ------------------------------
export async function upsertMatch(tournamentId, matchUpdate) {
  const t = await Tournament.findById(tournamentId);
  if (!t) {
    const err = new Error("Tournament not found");
    err.statusCode = 404;
    throw err;
  }

  const id = String(matchUpdate?.id || "").trim();
  if (!id) {
    const err = new Error("Match id required");
    err.statusCode = 400;
    throw err;
  }

  const idx = (t.matches || []).findIndex((m) => String(m.id) === id);
  if (idx < 0) {
    const err = new Error("Match not found");
    err.statusCode = 404;
    throw err;
  }

  const m = t.matches[idx];

  const active = isActiveStatus(t.status);
  const completed = isCompletedStatus(t.status);

  if (completed) {
    const err = new Error("Tournament is completed. Matches are locked.");
    err.statusCode = 409;
    throw err;
  }

  const tryingToChangeTeams =
    matchUpdate.teamA !== undefined ||
    matchUpdate.teamB !== undefined ||
    matchUpdate.teamAName !== undefined ||
    matchUpdate.teamBName !== undefined;

  if (active && tryingToChangeTeams) {
    const err = new Error("Tournament is live. You cannot change match teams.");
    err.statusCode = 409;
    throw err;
  }

  // ---------- apply patch ----------
  if (matchUpdate.teamA !== undefined) m.teamA = String(matchUpdate.teamA || "").trim();
  if (matchUpdate.teamB !== undefined) m.teamB = String(matchUpdate.teamB || "").trim();
  if (matchUpdate.teamAName !== undefined) m.teamAName = String(matchUpdate.teamAName || "").trim();
  if (matchUpdate.teamBName !== undefined) m.teamBName = String(matchUpdate.teamBName || "").trim();

  if (matchUpdate.venue !== undefined) m.venue = String(matchUpdate.venue || "").trim();

  // ✅ date/time: accept dateTime OR scheduledAt
  const dt =
    matchUpdate.dateTime !== undefined
      ? matchUpdate.dateTime
      : matchUpdate.scheduledAt !== undefined
        ? matchUpdate.scheduledAt
        : undefined;

  if (dt !== undefined) {
    m.dateTime = dt ? new Date(dt) : null;
    // Guard against invalid date strings
    if (m.dateTime && Number.isNaN(m.dateTime.getTime())) {
      const err = new Error("Invalid dateTime");
      err.statusCode = 400;
      throw err;
    }
  }

  if (matchUpdate.scoreA !== undefined) m.scoreA = Number(matchUpdate.scoreA || 0);
  if (matchUpdate.scoreB !== undefined) m.scoreB = Number(matchUpdate.scoreB || 0);

  // ✅ status normalization (be forgiving)
  if (matchUpdate.status !== undefined) {
    const raw = String(matchUpdate.status || "scheduled").trim().toLowerCase();
    if (raw === "played" || raw === "complete" || raw === "completed" || raw === "done") {
      m.status = "played";
    } else {
      m.status = "scheduled";
    }
  }

  // keep ids aligned after any team changes
  m.teamAId = pkToUserObjectId(m.teamA);
  m.teamBId = pkToUserObjectId(m.teamB);

  // playoff validation
  if (isPlayoffMatchId(m.id) && m.status === "played") {
    const aBye = String(m.teamA || "").trim().toUpperCase() === "BYE";
    const bBye = String(m.teamB || "").trim().toUpperCase() === "BYE";
    if (!aBye && !bBye && m.scoreA === m.scoreB) {
      const err = new Error("Playoff matches cannot end in a draw");
      err.statusCode = 400;
      throw err;
    }
  }

  // update playoffs tree / champion
  if (isPlayoffMatchId(m.id)) {
    const r = playoffRoundOf(m.id);
    if (r != null) {
      clearPlayoffRoundsAfter(t, r);
      autoProgressFromRound(t, r);
    } else {
      recomputeChampion(t);
    }
  } else {
    recomputeChampion(t);
  }

  await t.save();
  return t;
}

// ------------------------------
// Generate matches for any format
// ------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateRoundRobin(keys, defaultVenue = "", nameByKey) {
  const out = [];
  let counter = 1;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      out.push(makeMatchBase({ id: `rr_${counter++}`, teamA: keys[i], teamB: keys[j], venue: defaultVenue, nameByKey }));
    }
  }
  return out;
}

function generateKnockoutRound1(keys, defaultVenue = "", prefix = "ko", nameByKey) {
  const out = [];
  const shuffled = shuffle(keys);
  let counter = 1;

  for (let i = 0; i < shuffled.length; i += 2) {
    const a = shuffled[i];
    const b = i + 1 < shuffled.length ? shuffled[i + 1] : "BYE";
    out.push(makeMatchBase({ id: `${prefix}_${counter++}`, teamA: a, teamB: b, venue: defaultVenue, nameByKey }));
  }
  return out;
}

function generateDoubleElim(keys, defaultVenue = "", nameByKey) {
  return generateKnockoutRound1(keys, defaultVenue, "de_wb_r1", nameByKey);
}

export async function generateMatchesForFormat(tournamentId, { format, defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ allow after entries CLOSED, but not after FINALISE/START
  assertNotStartedOrCompleted(t);
  assertFormatNotFinalised(t);

  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  const keys = entrants.map((e) => String(e.participantKey || "").trim()).filter(Boolean);

  if (keys.length < 2) throw new Error("Add at least 2 players");

  const nameByKey = new Map(entrants.map((e) => [String(e.participantKey), pickEntrantName(e)]));

  const f = String(format || t.format || "").trim();
  const venue = String(defaultVenue || t.defaultVenue || t.playoffDefaultVenue || "").trim();

  if (f === "group_stage") {
    if (!t.groups || t.groups.length === 0) {
      const err = new Error("Groups not generated. Generate groups first.");
      err.statusCode = 400;
      throw err;
    }
    return await generateGroupMatches(tournamentId, { defaultVenue: venue });
  }

  let matches = [];
  if (f === "round_robin") matches = generateRoundRobin(keys, venue, nameByKey);
  else if (f === "knockout") matches = generateKnockoutRound1(keys, venue, "ko", nameByKey);
  else if (f === "double_elim" || f === "double_elimination") matches = generateDoubleElim(keys, venue, nameByKey);
  else matches = generateRoundRobin(keys, venue, nameByKey);

  t.matches = matches;
  t.championName = "";
  await t.save();
  return t;
}
