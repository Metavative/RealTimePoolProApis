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
// Playoffs helpers (participantKey-driven)
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
// Entrants (participantKey-based)
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

export async function setEntrants(tournamentId, entrantIds = []) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const ids = Array.isArray(entrantIds) ? entrantIds : [];
  if (ids.length < 2) throw new Error("Provide entrantIds (min 2)");

  const asKeys = ids
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((v) => {
      if (v.startsWith("uid:") || v.startsWith("un:") || v.startsWith("nm:")) return v;
      return `uid:${v}`;
    });

  const uidIds = asKeys
    .filter((k) => k.startsWith("uid:"))
    .map((k) => k.substring(4))
    .filter(Boolean);

  const byId = new Map();
  if (uidIds.length) {
    const users = await User.find({ _id: { $in: uidIds } })
      .select("profile.nickname stats.score stats.rank stats.totalWinnings stats.bestWinStreak stats.userIdTag")
      .lean();
    for (const u of users) byId.set(String(u._id), u);
  }

  const entrants = asKeys.map((pk) => {
    const objId = pk.startsWith("uid:") ? pk.substring(4) : "";
    const u = objId ? byId.get(String(objId)) : null;

    const name =
      (u?.profile?.nickname && String(u.profile.nickname).trim()) ||
      (u?.stats?.userIdTag && String(u.stats.userIdTag).trim()) ||
      "";

    return {
      participantKey: pk,
      entrantId: pkToUserObjectId(pk) || undefined,
      name,
      username: "",
      userId: objId || "",
      isLocal: pk.startsWith("nm:"),
      rating: u ? computeUserRating(u) : 0,
      seed: 0,
    };
  });

  entrants.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  for (let i = 0; i < entrants.length; i++) entrants[i].seed = i + 1;

  t.entrants = entrants;

  t.groups = [];
  t.matches = [];
  t.championName = "";

  await t.save();
  return t;
}

export async function setEntrantsObjects(tournamentId, entrants = []) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const clean = [];
  const seen = new Set();

  for (const raw of entrants) {
    const en = normEntrant(raw);
    if (!en) continue;
    if (seen.has(en.participantKey)) continue;
    seen.add(en.participantKey);
    clean.push(en);
  }

  const uidIds = clean
    .map((e) => (e.participantKey || "").startsWith("uid:") ? e.participantKey.substring(4) : "")
    .filter(Boolean);

  if (uidIds.length) {
    const users = await User.find({ _id: { $in: uidIds } })
      .select("profile.nickname stats.score stats.rank stats.totalWinnings stats.bestWinStreak stats.userIdTag")
      .lean();

    const byId = new Map(users.map((u) => [String(u._id), u]));

    for (const e of clean) {
      if (!e.participantKey.startsWith("uid:")) continue;
      const id = e.participantKey.substring(4);
      const u = byId.get(String(id));

      if (!e.name) {
        e.name =
          (u?.profile?.nickname && String(u.profile.nickname).trim()) ||
          (u?.stats?.userIdTag && String(u.stats.userIdTag).trim()) ||
          e.name ||
          "Player";
      }

      e.rating = computeUserRating(u);
      e.userId = e.userId || String(id);
    }
  }

  const seeded = clean.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
  for (let i = 0; i < seeded.length; i++) seeded[i].seed = i + 1;

  t.entrants = seeded;

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
// Standings for group_stage
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

    const parts = String(m.id).split("_"); // g, A, 1
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

// ------------------------------
// Playoffs generation
// ------------------------------
export async function generatePlayoffs(tournamentId, { defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  if (t.format !== "group_stage") throw new Error("Tournament is not group_stage");
  if (!t.groups || t.groups.length === 0) throw new Error("Groups not generated");

  t.playoffDefaultVenue = String(defaultVenue || "").trim();

  const hasGroupMatches = (t.matches || []).some((m) => isGroupMatchId(m.id));
  if (!hasGroupMatches) {
    await generateGroupMatches(tournamentId, { defaultVenue });
    const fresh = await Tournament.findById(tournamentId);
    if (!fresh) throw new Error("Tournament not found after group match generation");
    t.groups = fresh.groups;
    t.matches = fresh.matches;
    t.entrants = fresh.entrants;
  }

  removePlayoffs(t);

  const standings = computeGroupStandings(t);
  const qualifiersByGroup = {};

  for (const g of t.groups) {
    const rows = standings[g.id] || [];
    const n = Math.min(Number(t.topNPerGroup || 1), Math.max(0, rows.length));
    qualifiersByGroup[g.id] = rows.slice(0, n);
  }

  const totalQualifiers = Object.values(qualifiersByGroup).reduce((a, b) => a + b.length, 0);
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
        venue: defaultVenue || "",
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
        venue: defaultVenue || "",
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
// Match update (LOCK teams after ACTIVE)
// ------------------------------
export async function upsertMatch(tournamentId, matchUpdate) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const id = String(matchUpdate?.id || "").trim();
  if (!id) throw new Error("Match id required");

  const idx = (t.matches || []).findIndex((m) => m.id === id);
  if (idx < 0) throw new Error("Match not found");

  const m = t.matches[idx];

  const active = isActiveStatus(t.status);
  const completed = isCompletedStatus(t.status);

  if (completed) {
    throw new Error("Tournament is completed. Matches are locked.");
  }

  // ✅ After ACTIVE: teams cannot be changed (only score/status/date/venue)
  const tryingToChangeTeams =
    matchUpdate.teamA !== undefined ||
    matchUpdate.teamB !== undefined ||
    matchUpdate.teamAName !== undefined ||
    matchUpdate.teamBName !== undefined;

  if (active && tryingToChangeTeams) {
    throw new Error("Tournament is live. You cannot change match teams.");
  }

  // Safe updates
  if (matchUpdate.teamA !== undefined) m.teamA = String(matchUpdate.teamA || "");
  if (matchUpdate.teamB !== undefined) m.teamB = String(matchUpdate.teamB || "");
  if (matchUpdate.teamAName !== undefined) m.teamAName = String(matchUpdate.teamAName || "");
  if (matchUpdate.teamBName !== undefined) m.teamBName = String(matchUpdate.teamBName || "");
  if (matchUpdate.venue !== undefined) m.venue = String(matchUpdate.venue || "");
  if (matchUpdate.dateTime !== undefined)
    m.dateTime = matchUpdate.dateTime ? new Date(matchUpdate.dateTime) : null;

  if (matchUpdate.scoreA !== undefined) m.scoreA = Number(matchUpdate.scoreA || 0);
  if (matchUpdate.scoreB !== undefined) m.scoreB = Number(matchUpdate.scoreB || 0);
  if (matchUpdate.status !== undefined) m.status = String(matchUpdate.status || "scheduled");

  // keep ids consistent if teamA/teamB are uid:
  m.teamAId = pkToUserObjectId(m.teamA);
  m.teamBId = pkToUserObjectId(m.teamB);

  if (isPlayoffMatchId(m.id) && m.status === "played") {
    const aBye = String(m.teamA || "").trim().toUpperCase() === "BYE";
    const bBye = String(m.teamB || "").trim().toUpperCase() === "BYE";
    if (!aBye && !bBye && m.scoreA === m.scoreB) {
      throw new Error("Playoff matches cannot end in a draw");
    }
  }

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
// Generate matches for any format (participantKey-based)
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

function generateDoubleElim(keys, defaultVenue = "", nameByKey) {
  return generateKnockoutRound1(keys, defaultVenue, "de_wb_r1", nameByKey);
}

export async function generateMatchesForFormat(tournamentId, { format, defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const entrants = Array.isArray(t.entrants) ? t.entrants : [];
  const keys = entrants
    .map((e) => String(e.participantKey || "").trim())
    .filter(Boolean);

  if (keys.length < 2) throw new Error("Add at least 2 players");

  const nameByKey = new Map(
    entrants.map((e) => [String(e.participantKey), pickEntrantName(e)])
  );

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
