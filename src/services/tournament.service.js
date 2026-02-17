import Tournament from "../models/tournament.model.js";
import User from "../models/user.model.js";
import { computeUserRating } from "./seedRating.service.js";

// ------------------------------
// small helpers
// ------------------------------
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
  // Let mongoose validate at save time; still return string for ObjectId casting
  return id || null;
}

function playoffWinner(match) {
  const aBye = String(match.teamAName || "").trim().toUpperCase() === "BYE";
  const bBye = String(match.teamBName || "").trim().toUpperCase() === "BYE";

  if (aBye && !bBye) return match.teamBName;
  if (bBye && !aBye) return match.teamAName;
  if (aBye && bBye) return null;

  if (match.status !== "played") return null;
  if (match.scoreA === match.scoreB) return null;

  return match.scoreA > match.scoreB ? match.teamAName : match.teamBName;
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
    const w = playoffWinner(m);
    if (!w) {
      t.championName = "";
      return;
    }
    winners.push(w);
  }

  t.championName = winners.length === 1 ? winners[0] : "";
}

function autoProgressFromRound(t, startRound) {
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
      const w = playoffWinner(m);
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
      if (i + 1 >= winners.length) {
        out.push({
          id: `po_r${nextRound}_${counter}`,
          teamA: "", // not needed for playoffs (names drive)
          teamB: "",
          teamAId: null,
          teamBId: null,
          teamAName: winners[i],
          teamBName: "BYE",
          venue: t.playoffDefaultVenue || "",
          dateTime: null,
          scoreA: 0,
          scoreB: 0,
          status: "scheduled",
        });
        counter++;
        break;
      }

      out.push({
        id: `po_r${nextRound}_${counter}`,
        teamA: "",
        teamB: "",
        teamAId: null,
        teamBId: null,
        teamAName: winners[i],
        teamBName: winners[i + 1],
        venue: t.playoffDefaultVenue || "",
        dateTime: null,
        scoreA: 0,
        scoreB: 0,
        status: "scheduled",
      });
      counter++;
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

  // optional: compute rating only for uid entrants
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
    }
  }

  // seed strongest->weakest (rating)
  const seeded = clean.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
  for (let i = 0; i < seeded.length; i++) seeded[i].seed = i + 1;

  t.entrants = seeded;

  // reset derived items
  t.groups = [];
  t.matches = [];
  t.championName = "";

  await t.save();
  return t;
}

// ------------------------------
// Balanced Groups (snake seeding)
// members are participantKeys
// ------------------------------
export async function generateGroupsSeeded(tournamentId, { groupCount, groupSize, randomize }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  if (!t.entrants || t.entrants.length < 2) {
    throw new Error("Entrants not set");
  }

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

  // seeded strongest -> weakest via seed
  const seeded = list.slice().sort((a, b) => (a.seed || 9999) - (b.seed || 9999));

  if (randomize) {
    seeded.sort(() => Math.random() - 0.5);
  }

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
// teamA/teamB are participantKeys
// ------------------------------
export async function generateGroupMatches(tournamentId, { defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  if (t.format !== "group_stage") throw new Error("Tournament is not group_stage");
  if (!t.groups || t.groups.length === 0) throw new Error("Groups not generated");

  t.matches = [];
  t.championName = "";

  const matches = [];

  // nameByKey from entrants
  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), String(e.name || "Player")])
  );

  for (const g of t.groups) {
    const members = (g.members || []).map((x) => String(x)).filter(Boolean);
    let counter = 1;

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const teamA = members[i];
        const teamB = members[j];

        matches.push({
          id: `g_${g.id}_${counter}`,
          teamA,
          teamB,
          teamAId: pkToUserObjectId(teamA),
          teamBId: pkToUserObjectId(teamB),
          teamAName: nameByKey.get(teamA) || "Player",
          teamBName: nameByKey.get(teamB) || "Player",
          venue: defaultVenue || "",
          dateTime: null,
          scoreA: 0,
          scoreB: 0,
          status: "scheduled",
        });
        counter++;
      }
    }
  }

  t.matches = matches;
  await t.save();
  return t;
}

// ------------------------------
// Standings for group_stage
// uses match.teamA/teamB participantKeys
// ------------------------------
function computeGroupStandings(t) {
  const byGroup = new Map();

  const nameByKey = new Map(
    (t.entrants || []).map((e) => [String(e.participantKey), String(e.name || "Player")])
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
// Playoffs generation (names driven)
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
      if (r < list.length) ordered.push(list[r].name);
    }
  }

  const out = [];
  let counter = 1;

  let i = 0;
  let j = ordered.length - 1;
  while (i < j) {
    out.push({
      id: `po_r1_${counter}`,
      teamA: "",
      teamB: "",
      teamAId: null,
      teamBId: null,
      teamAName: ordered[i],
      teamBName: ordered[j],
      venue: defaultVenue || "",
      dateTime: null,
      scoreA: 0,
      scoreB: 0,
      status: "scheduled",
    });
    counter++;
    i++;
    j--;
  }

  if (i === j) {
    out.push({
      id: `po_r1_${counter}`,
      teamA: "",
      teamB: "",
      teamAId: null,
      teamBId: null,
      teamAName: ordered[i],
      teamBName: "BYE",
      venue: defaultVenue || "",
      dateTime: null,
      scoreA: 0,
      scoreB: 0,
      status: "scheduled",
    });
  }

  t.matches = [...(t.matches || []), ...out];

  autoProgressFromRound(t, 1);
  await t.save();
  return t;
}

// ------------------------------
// Match update (auto-progress + champion)
// ------------------------------
export async function upsertMatch(tournamentId, matchUpdate) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const id = String(matchUpdate?.id || "").trim();
  if (!id) throw new Error("Match id required");

  const idx = (t.matches || []).findIndex((m) => m.id === id);
  if (idx < 0) throw new Error("Match not found");

  const m = t.matches[idx];

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
    const aBye = String(m.teamAName || "").trim().toUpperCase() === "BYE";
    const bBye = String(m.teamBName || "").trim().toUpperCase() === "BYE";
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

function generateRoundRobin(keys, defaultVenue = "") {
  const out = [];
  let counter = 1;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      out.push({
        id: `rr_${counter++}`,
        teamA: keys[i],
        teamB: keys[j],
        teamAId: pkToUserObjectId(keys[i]),
        teamBId: pkToUserObjectId(keys[j]),
        teamAName: "",
        teamBName: "",
        venue: defaultVenue,
        dateTime: null,
        scoreA: 0,
        scoreB: 0,
        status: "scheduled",
      });
    }
  }
  return out;
}

function generateKnockoutRound1(keys, defaultVenue = "", prefix = "ko") {
  const out = [];
  const shuffled = shuffle(keys);
  let counter = 1;

  for (let i = 0; i < shuffled.length; i += 2) {
    const a = shuffled[i];
    const b = i + 1 < shuffled.length ? shuffled[i + 1] : "BYE";
    out.push({
      id: `${prefix}_${counter++}`,
      teamA: a,
      teamB: b,
      teamAId: pkToUserObjectId(a),
      teamBId: b === "BYE" ? null : pkToUserObjectId(b),
      teamAName: "",
      teamBName: b === "BYE" ? "BYE" : "",
      venue: defaultVenue,
      dateTime: null,
      scoreA: 0,
      scoreB: 0,
      status: "scheduled",
    });
  }
  return out;
}

function generateDoubleElim(keys, defaultVenue = "") {
  return generateKnockoutRound1(keys, defaultVenue, "de_w1");
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
    entrants.map((e) => [String(e.participantKey), String(e.name || "Player").trim() || "Player"])
  );

  const f = String(format || t.format || "").trim();

  let rawMatches = [];

  if (f === "group_stage") {
    rawMatches = generateRoundRobin(keys, defaultVenue);
  } else if (f === "round_robin") {
    rawMatches = generateRoundRobin(keys, defaultVenue);
  } else if (f === "knockout") {
    rawMatches = generateKnockoutRound1(keys, defaultVenue, "ko");
  } else if (f === "double_elim" || f === "double_elimination") {
    rawMatches = generateDoubleElim(keys, defaultVenue);
  } else {
    rawMatches = generateRoundRobin(keys, defaultVenue);
  }

  const matches = rawMatches.map((m) => ({
    ...m,
    teamAName: m.teamAName || nameByKey.get(m.teamA) || "Player",
    teamBName: m.teamB === "BYE" ? "BYE" : (m.teamBName || nameByKey.get(m.teamB) || "Player"),
  }));

  t.matches = matches;
  await t.save();
  return t;
}
