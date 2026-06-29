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

function normalizeFormat(value, fallback = "round_robin") {
  const raw = String(value || "")
    .trim()
    .toLowerCase();

  if (!raw) return fallback;
  if (raw === "round robin" || raw === "roundrobin") return "round_robin";
  if (raw === "group stage" || raw === "groupstage") return "group_stage";
  if (
    raw === "double elimination" ||
    raw === "double-elimination" ||
    raw === "double_elim" ||
    raw === "double-elim"
  ) {
    return "double_elimination";
  }
  if (raw === "single_elim" || raw === "single_elimination") return "knockout";
  if (raw === "killer") return "killer";
  if (raw === "round_robin" || raw === "group_stage" || raw === "knockout") {
    return raw;
  }
  if (raw === "double_elimination" || raw === "double_elim") {
    return "double_elimination";
  }
  return fallback;
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

function isDoubleElimMatchId(id) {
  return String(id || "").startsWith("de_");
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

function buildNameByKey(t) {
  return new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );
}

function applyNamesForMatchFromEntrants(t, match) {
  const nameByKey = buildNameByKey(t);

  const aKey = String(match.teamA || "").trim();
  const bKey = String(match.teamB || "").trim();

  match.teamAName =
    aKey.toUpperCase() === "BYE"
      ? "BYE"
      : (nameByKey.get(aKey) || String(match.teamAName || "").trim() || "Player");

  match.teamBName =
    bKey.toUpperCase() === "BYE"
      ? "BYE"
      : (nameByKey.get(bKey) || String(match.teamBName || "").trim() || "Player");
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
// ✅ roster comparison helpers (prevents match wipe when roster unchanged)
// ------------------------------
function rosterKeysOfEntrants(entrants) {
  const keys = (Array.isArray(entrants) ? entrants : [])
    .map((e) => String(e?.participantKey || "").trim())
    .filter(Boolean);
  keys.sort();
  return keys;
}

function sameRosterByParticipantKey(oldEntrants, newEntrants) {
  const a = rosterKeysOfEntrants(oldEntrants);
  const b = rosterKeysOfEntrants(newEntrants);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function refreshAllMatchNamesFromEntrants(t) {
  if (!Array.isArray(t.matches) || t.matches.length === 0) return;
  for (const m of t.matches) {
    applyNamesForMatchFromEntrants(t, m);
    // keep ids aligned too (safe)
    m.teamAId = pkToUserObjectId(m.teamA);
    m.teamBId = pkToUserObjectId(m.teamB);
  }
}

// ------------------------------
// Playoffs helpers
// ------------------------------
function nextPowerOf2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

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

  // ✅ clear metadata
  t.playoffs = {
    generatedAt: null,
    qualifiersPerGroup: 0,
    bracketSize: 0,
    force: false,
    venue: "",
  };
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
    .map((e) =>
      (e.participantKey || "").startsWith("uid:") ? e.participantKey.substring(4) : ""
    )
    .filter(Boolean);

  let byId = new Map();
  if (uidIds.length) {
    const users = await User.find({ _id: { $in: uidIds } })
      .select(
        "profile.nickname stats.score stats.rank stats.totalWinnings stats.bestWinStreak stats.userIdTag"
      )
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

  const before = t.entrants || [];
  t.entrants = await reseedEntrantsFromCurrentList(t.entrants);

  // ✅ roster changed (added) => clear generated data (existing logic)
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

  const incoming = await reseedEntrantsFromCurrentList(
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

  const rosterSame = sameRosterByParticipantKey(t.entrants, incoming);

  t.entrants = incoming;

  // ✅ Only clear generated data if roster actually changed
  if (!rosterSame) {
    t.groups = [];
    t.matches = [];
    t.championName = "";
  } else {
    // keep matches/groups; just refresh names for consistency
    refreshAllMatchNamesFromEntrants(t);
  }

  await t.save();
  return t;
}

export async function setEntrantsObjects(tournamentId, entrants = []) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertRosterMutable(t);

  const incoming = await reseedEntrantsFromCurrentList(entrants);
  const rosterSame = sameRosterByParticipantKey(t.entrants, incoming);

  t.entrants = incoming;

  // ✅ Only clear groups/matches when roster changes
  if (!rosterSame) {
    t.groups = [];
    t.matches = [];
    t.championName = "";
  } else {
    // keep generated data; update names/id links
    refreshAllMatchNamesFromEntrants(t);
  }

  await t.save();
  return t;
}

// ------------------------------
// Balanced Groups (snake seeding)
// ------------------------------
export async function generateGroupsSeeded(
  tournamentId,
  { groupCount, groupSize, randomize },
  options = {}
) {
  const { allowFinalised = false } = options;

  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ Step 2 completion: entries CLOSED is OK for generation
  assertNotStartedOrCompleted(t);
  if (!allowFinalised) {
    assertFormatNotFinalised(t);
  }

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
export async function generateGroupMatches(tournamentId, { defaultVenue }, options = {}) {
  const { allowFinalised = false } = options;

  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  assertNotStartedOrCompleted(t);
  if (!allowFinalised) {
    assertFormatNotFinalised(t);
  }

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
      return String(x.name)
        .toLowerCase()
        .localeCompare(String(y.name).toLowerCase());
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
// Regenerate matches safely before start (finalised format)
// ------------------------------
export async function regenerateFinalisedMatchesForStart(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) {
    const err = new Error("Tournament not found");
    err.statusCode = 404;
    throw err;
  }

  // Only allowed before start
  assertNotStartedOrCompleted(t);

  if (!isEntriesClosed(t)) {
    const err = new Error("Close entries first");
    err.statusCode = 400;
    throw err;
  }

  if (!isFormatFinalised(t)) {
    const err = new Error("Finalise format first");
    err.statusCode = 409;
    throw err;
  }

  const format = normalizeFormat(t.format, "round_robin");

  // Clear generated data safely
  t.groups = t.groups || [];
  t.matches = [];
  t.championName = "";
  await t.save();

  // Rebuild from current tournament state
  if (format === "group_stage") {
    if (!t.groups || t.groups.length === 0) {
      const cfg = {
        groupCount: Number(t.groupCount || 2),
        groupRandomize: Boolean(t.groupRandomize),
      };

      await generateGroupsSeeded(
        tournamentId,
        {
          groupCount: cfg.groupCount,
          groupSize: undefined,
          randomize: cfg.groupRandomize,
        },
        { allowFinalised: true }
      );
    }

    const t2 = await Tournament.findById(tournamentId);
    const venue2 = String(t2.defaultVenue || t2.playoffDefaultVenue || "").trim();

    await generateGroupMatches(
      tournamentId,
      { defaultVenue: venue2 },
      { allowFinalised: true }
    );
  } else {
    const entrants = Array.isArray(t.entrants) ? t.entrants : [];
    const keys = entrants
      .map((e) => String(e.participantKey || "").trim())
      .filter(Boolean);
    if (keys.length < 2) {
      const err = new Error("Need at least 2 entrants");
      err.statusCode = 400;
      throw err;
    }

    const nameByKey = new Map(
      entrants.map((e) => [String(e.participantKey), pickEntrantName(e)])
    );

    const venue = String(t.defaultVenue || t.playoffDefaultVenue || "").trim();

    let matches = [];
    if (format === "round_robin") matches = generateRoundRobin(keys, venue, nameByKey);
    else if (format === "knockout" || format === "killer")
      matches = generateKnockoutRound1(keys, venue, "ko", nameByKey);
    else if (format === "double_elim" || format === "double_elimination")
      matches = generateDoubleElim(keys, venue, nameByKey);
    else matches = generateRoundRobin(keys, venue, nameByKey);

    const t3 = await Tournament.findById(tournamentId);
    if (!t3) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    t3.matches = matches;
    t3.championName = "";
    if (format === "double_elim" || format === "double_elimination") {
      progressDoubleElimination(t3);
    }
    await t3.save();
  }

  return await Tournament.findById(tournamentId);
}

// ------------------------------
// Playoffs generation (ACTIVE-safe: allowed during ACTIVE/LIVE when format FINALISED)
// ------------------------------
export async function generatePlayoffs(tournamentId, { defaultVenue, force = false }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ Playoffs are a LIVE operation (your current rule)
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

  // ✅ Idempotent by default
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

  // ✅ Venue chain
  const venue = String(defaultVenue || t.playoffDefaultVenue || t.defaultVenue || "").trim();
  t.playoffDefaultVenue = venue;

  // ✅ Canonical qualifiersPerGroup (Step 4 rule)
  const qpg = Math.max(1, Number(t?.formatConfig?.qualifiersPerGroup ?? 1));

  // Create playoffs from standings
  const standings = computeGroupStandings(t);

  const qualifiersByGroup = {};
  for (const g of t.groups) {
    const rows = standings[g.id] || [];
    const n = Math.min(qpg, Math.max(0, rows.length));
    qualifiersByGroup[g.id] = rows.slice(0, n);
  }

  // ✅ Deterministic ordering:
  // r=0: all group winners in group order
  // r=1: all group runners-up in group order
  // etc
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

  if (ordered.length < 2) {
    // Save metadata even if insufficient
    t.playoffs = {
      generatedAt: new Date(),
      qualifiersPerGroup: qpg,
      bracketSize: 0,
      force: !!force,
      venue,
    };
    await t.save();
    return t;
  }

  // ✅ Bracket sizing: next power-of-2
  const bracketSize = nextPowerOf2(ordered.length);

  // Add BYEs deterministically at the end
  const seeded = ordered.slice();
  while (seeded.length < bracketSize) seeded.push("BYE");

  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  // ✅ Round 1: high vs low (1 vs N, 2 vs N-1, ...)
  const out = [];
  let counter = 1;

  let i = 0;
  let j = seeded.length - 1;
  while (i < j) {
    out.push(
      makeMatchBase({
        id: `po_r1_${counter++}`,
        teamA: seeded[i],
        teamB: seeded[j],
        venue,
        nameByKey,
      })
    );
    i++;
    j--;
  }

  t.matches = [...(t.matches || []), ...out];

  // ✅ Persist metadata
  t.playoffs = {
    generatedAt: new Date(),
    qualifiersPerGroup: qpg,
    bracketSize,
    force: !!force,
    venue,
  };

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
  let teamsChanged = false;

  if (matchUpdate.teamA !== undefined) {
    const next = String(matchUpdate.teamA || "").trim();
    if (next !== m.teamA) teamsChanged = true;
    m.teamA = next;
  }

  if (matchUpdate.teamB !== undefined) {
    const next = String(matchUpdate.teamB || "").trim();
    if (next !== m.teamB) teamsChanged = true;
    m.teamB = next;
  }

  // allow explicit names, but server will ensure consistency (esp when teams changed)
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

  // ✅ Ensure names are consistent from entrants (and normalize BYE)
  if (teamsChanged || !String(m.teamAName || "").trim() || !String(m.teamBName || "").trim()) {
    applyNamesForMatchFromEntrants(t, m);
  } else {
    if (String(m.teamA || "").trim().toUpperCase() === "BYE") m.teamAName = "BYE";
    if (String(m.teamB || "").trim().toUpperCase() === "BYE") m.teamBName = "BYE";
  }

  // playoff / double-elim validation: elimination matches cannot end in a draw
  if ((isPlayoffMatchId(m.id) || isDoubleElimMatchId(m.id)) && m.status === "played") {
    const aBye = String(m.teamA || "").trim().toUpperCase() === "BYE";
    const bBye = String(m.teamB || "").trim().toUpperCase() === "BYE";
    if (!aBye && !bBye && m.scoreA === m.scoreB) {
      const err = new Error("Elimination matches cannot end in a draw");
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
  } else if (isDoubleElimMatchId(m.id)) {
    // Recompute the whole double-elim bracket from the played results so an
    // edited result cascades through both brackets and the grand final.
    progressDoubleElimination(t);
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
      out.push(
        makeMatchBase({
          id: `rr_${counter++}`,
          teamA: keys[i],
          teamB: keys[j],
          venue: defaultVenue,
          nameByKey,
        })
      );
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
    out.push(
      makeMatchBase({
        id: `${prefix}_${counter++}`,
        teamA: a,
        teamB: b,
        venue: defaultVenue,
        nameByKey,
      })
    );
  }
  return out;
}

// ============================================================================
// Double elimination
//
// Full bracket generated up front: a winners bracket (WB), a losers bracket
// (LB) fed by WB losers, and a grand final with a bracket-reset game. Match ids
// encode the bracket/round/position: de_wb_r{R}_{P}, de_lb_r{R}_{P}, de_gf_1,
// de_gf_2. WB round 1 holds the actual seeded draw; every other slot starts as
// "TBD" and is filled by progressDoubleElimination() as results come in.
//
// Progression recomputes ALL derived slots from the played results on every
// edit, so changing an earlier result correctly cascades (and stale downstream
// results are cleared). BYEs propagate cleanly: a bye "advances" as BYE so the
// opponent auto-wins, and a bye never drops a real loser into the LB.
// ============================================================================

const DE_TBD = "TBD";

function deIsBye(key) {
  return String(key || "").trim().toUpperCase() === "BYE";
}
function deIsTbd(key) {
  const k = String(key || "").trim();
  return k === "" || k.toUpperCase() === "TBD";
}
function deIsReal(key) {
  return !deIsBye(key) && !deIsTbd(key);
}

function deName(key, nameByKey) {
  if (deIsBye(key)) return "BYE";
  if (deIsTbd(key)) return "TBD";
  return nameByKey.get(String(key).trim()) || "Player";
}

function makeDeMatch({ id, a, b, venue, nameByKey }) {
  const A = String(a == null || a === "" ? DE_TBD : a).trim();
  const B = String(b == null || b === "" ? DE_TBD : b).trim();
  const m = makeMatchBase({ id, teamA: A, teamB: B, venue, nameByKey });
  m.teamAName = deName(A, nameByKey);
  m.teamBName = deName(B, nameByKey);
  if (!deIsReal(A)) m.teamAId = null;
  if (!deIsReal(B)) m.teamBId = null;
  return m;
}

// Standard tournament seed order (1, then 1/2, then 1/4/3/2, ...) so top seeds
// are spread out and any BYEs fall against the strongest seeds.
function standardSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s);
      next.push(n + 1 - s);
    }
    order = next;
  }
  return order;
}

// The key that ADVANCES out of a match (winner). A bye advances as "BYE" so a
// downstream opponent auto-wins; an undecided match yields "TBD".
function deAdvancingKey(m) {
  if (!m) return DE_TBD;
  const a = String(m.teamA || "").trim();
  const b = String(m.teamB || "").trim();
  if (deIsReal(a) && deIsBye(b)) return a;
  if (deIsReal(b) && deIsBye(a)) return b;
  if (deIsBye(a) && deIsBye(b)) return "BYE";
  if (!deIsReal(a) || !deIsReal(b)) return DE_TBD;
  if (m.status !== "played" || Number(m.scoreA) === Number(m.scoreB)) return DE_TBD;
  return Number(m.scoreA) > Number(m.scoreB) ? a : b;
}

// The key that DROPS to the losers bracket. "BYE" when no real player loses
// (a bye match), "TBD" when undecided.
function deLoserDropKey(m) {
  if (!m) return DE_TBD;
  const a = String(m.teamA || "").trim();
  const b = String(m.teamB || "").trim();
  if (deIsBye(a) || deIsBye(b)) return "BYE";
  if (!deIsReal(a) || !deIsReal(b)) return DE_TBD;
  if (m.status !== "played" || Number(m.scoreA) === Number(m.scoreB)) return DE_TBD;
  return Number(m.scoreA) > Number(m.scoreB) ? b : a;
}

// A concrete real winner (used for the champion); null unless decided between
// two real players.
function deRealWinner(m) {
  const k = deAdvancingKey(m);
  return deIsReal(k) ? k : null;
}

export function generateDoubleElim(keys, defaultVenue = "", nameByKey) {
  const real = shuffle((keys || []).filter(Boolean));
  const n = real.length;
  if (n < 2) return [];

  const S = Math.max(2, nextPowerOf2(n)); // bracket size (power of 2)
  const W = Math.round(Math.log2(S)); // number of WB rounds
  const venue = String(defaultVenue || "").trim();

  const seedOrder = standardSeedOrder(S);
  const slotKeys = seedOrder.map((seed) => (seed <= n ? real[seed - 1] : "BYE"));

  const out = [];

  // Winners bracket round 1 — the actual seeded draw.
  for (let p = 0; p < S / 2; p++) {
    out.push(
      makeDeMatch({
        id: `de_wb_r1_${p + 1}`,
        a: slotKeys[2 * p],
        b: slotKeys[2 * p + 1],
        venue,
        nameByKey,
      })
    );
  }

  // Winners bracket rounds 2..W — placeholders.
  for (let r = 2; r <= W; r++) {
    const count = S / Math.pow(2, r);
    for (let p = 1; p <= count; p++) {
      out.push(makeDeMatch({ id: `de_wb_r${r}_${p}`, a: DE_TBD, b: DE_TBD, venue, nameByKey }));
    }
  }

  // Losers bracket rounds 1..(2W-2) — placeholders.
  const lbRounds = 2 * W - 2;
  for (let r = 1; r <= lbRounds; r++) {
    const level = Math.ceil(r / 2);
    const count = S / Math.pow(2, level + 1);
    for (let p = 1; p <= count; p++) {
      out.push(makeDeMatch({ id: `de_lb_r${r}_${p}`, a: DE_TBD, b: DE_TBD, venue, nameByKey }));
    }
  }

  // Grand final + bracket-reset game.
  out.push(makeDeMatch({ id: "de_gf_1", a: DE_TBD, b: DE_TBD, venue, nameByKey }));
  out.push(makeDeMatch({ id: "de_gf_2", a: DE_TBD, b: DE_TBD, venue, nameByKey }));

  return out;
}

export function progressDoubleElimination(t) {
  const matches = Array.isArray(t.matches) ? t.matches : [];
  const de = matches.filter((m) => isDoubleElimMatchId(m.id));
  if (de.length === 0) return;

  const byId = new Map(de.map((m) => [String(m.id), m]));
  const get = (id) => byId.get(String(id)) || null;

  const wbR1Count = de.filter((m) => /^de_wb_r1_\d+$/.test(m.id)).length;
  const S = wbR1Count * 2;
  if (S < 2) return;
  const W = Math.round(Math.log2(S));
  const nameByKey = buildNameByKey(t);

  // Set a derived slot; clear any stale result if the participants changed.
  const setSlot = (m, a, b) => {
    if (!m) return;
    const A = String(a == null || a === "" ? DE_TBD : a).trim();
    const B = String(b == null || b === "" ? DE_TBD : b).trim();
    if (String(m.teamA) !== A || String(m.teamB) !== B) {
      m.teamA = A;
      m.teamB = B;
      m.teamAId = deIsReal(A) ? pkToUserObjectId(A) : null;
      m.teamBId = deIsReal(B) ? pkToUserObjectId(B) : null;
      m.scoreA = 0;
      m.scoreB = 0;
      m.status = "scheduled";
    }
    m.teamAName = deName(A, nameByKey);
    m.teamBName = deName(B, nameByKey);
  };

  // Winners bracket rounds 2..W.
  for (let r = 2; r <= W; r++) {
    const count = S / Math.pow(2, r);
    for (let p = 1; p <= count; p++) {
      setSlot(
        get(`de_wb_r${r}_${p}`),
        deAdvancingKey(get(`de_wb_r${r - 1}_${2 * p - 1}`)),
        deAdvancingKey(get(`de_wb_r${r - 1}_${2 * p}`))
      );
    }
  }

  // Losers bracket.
  const lbRounds = 2 * W - 2;
  for (let r = 1; r <= lbRounds; r++) {
    const level = Math.ceil(r / 2);
    const count = S / Math.pow(2, level + 1);
    for (let p = 1; p <= count; p++) {
      let a;
      let b;
      if (r === 1) {
        // Pair up the WB round 1 losers.
        a = deLoserDropKey(get(`de_wb_r1_${2 * p - 1}`));
        b = deLoserDropKey(get(`de_wb_r1_${2 * p}`));
      } else if (r % 2 === 0) {
        // Major round: previous LB winner vs a WB loser dropping in.
        a = deAdvancingKey(get(`de_lb_r${r - 1}_${p}`));
        b = deLoserDropKey(get(`de_wb_r${level + 1}_${p}`));
      } else {
        // Minor round: pair up the previous (major) LB round winners.
        a = deAdvancingKey(get(`de_lb_r${r - 1}_${2 * p - 1}`));
        b = deAdvancingKey(get(`de_lb_r${r - 1}_${2 * p}`));
      }
      setSlot(get(`de_lb_r${r}_${p}`), a, b);
    }
  }

  // Grand final: WB champion vs LB champion. With no LB (S=2), the "LB
  // champion" is simply the WB final's loser.
  const wbFinal = get(`de_wb_r${W}_1`);
  const lbFinal = lbRounds >= 1 ? get(`de_lb_r${lbRounds}_1`) : null;
  const wbWinner = deAdvancingKey(wbFinal);
  const lbWinner = lbRounds >= 1 ? deAdvancingKey(lbFinal) : deLoserDropKey(wbFinal);

  const gf1 = get("de_gf_1");
  setSlot(gf1, wbWinner, lbWinner);

  const gf2 = get("de_gf_2");
  const gf1A = String(gf1?.teamA || "").trim();
  const gf1B = String(gf1?.teamB || "").trim();
  const gf1Winner = deRealWinner(gf1);

  let champion = "";
  if (gf1Winner && gf1Winner === gf1A) {
    // The WB side stayed unbeaten — champion, no reset needed.
    champion = gf1Winner;
    setSlot(gf2, DE_TBD, DE_TBD);
  } else if (gf1Winner && gf1Winner === gf1B) {
    // The LB side handed the WB side its first loss — play the reset game.
    setSlot(gf2, gf1A, gf1B);
    champion = deRealWinner(gf2) || "";
  } else {
    setSlot(gf2, DE_TBD, DE_TBD);
  }

  t.championName = champion || "";
}

export async function generateMatchesForFormat(tournamentId, { format, defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  // ✅ allow after entries CLOSED, but not after FINALISE/START
  assertNotStartedOrCompleted(t);
  assertFormatNotFinalised(t);

  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  const keys = entrants
    .map((e) => String(e.participantKey || "").trim())
    .filter(Boolean);

  if (keys.length < 2) throw new Error("Add at least 2 players");

  const nameByKey = new Map(
    entrants.map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

  const f = normalizeFormat(format || t.format, "round_robin");
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
  else if (f === "knockout" || f === "killer")
    matches = generateKnockoutRound1(keys, venue, "ko", nameByKey);
  else if (f === "double_elim" || f === "double_elimination")
    matches = generateDoubleElim(keys, venue, nameByKey);
  else matches = generateRoundRobin(keys, venue, nameByKey);

  t.matches = matches;
  t.championName = "";
  // Resolve any first-round byes into the next slots immediately.
  if (f === "double_elim" || f === "double_elimination") progressDoubleElimination(t);
  await t.save();
  return t;
}
