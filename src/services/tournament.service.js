import Tournament from "../models/tournament.model.js";
import User from "../models/user.model.js";
import { computeUserRating } from "./seedRating.service.js";

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
  // po_r<round>_<n>
  const parts = String(id || "").split("_"); // po, r1, 1
  if (parts.length < 3) return null;
  const r = parts[1]; // r1
  if (!r || !r.startsWith("r")) return null;
  const n = parseInt(r.substring(1), 10);
  return Number.isFinite(n) ? n : null;
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

    // Create next round
    const out = [];
    let counter = 1;

    for (let i = 0; i < winners.length; i += 2) {
      if (i + 1 >= winners.length) {
        out.push({
          id: `po_r${nextRound}_${counter}`,
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
// Entrants & Seeding
// ------------------------------
export async function setEntrants(tournamentId, entrantIds) {
  const ids = (entrantIds || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (ids.length < 2) {
    throw new Error("Need at least 2 entrants");
  }

  const users = await User.find({ _id: { $in: ids } })
    .select("profile.nickname stats.score stats.rank stats.totalWinnings stats.bestWinStreak stats.userIdTag")
    .lean();

  // Keep original order if provided, but fill missing safe
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const entrants = ids.map((id) => {
    const u = byId.get(id);
    const name =
      (u?.profile?.nickname && String(u.profile.nickname).trim()) ||
      (u?.stats?.userIdTag && String(u.stats.userIdTag).trim()) ||
      "Player";

    const rating = computeUserRating(u);

    return {
      entrantId: id,
      name,
      rating,
      seed: 0,
    };
  });

  // Seed strongest -> weakest
  const seeded = entrants
    .slice()
    .sort((a, b) => (b.rating || 0) - (a.rating || 0));

  for (let i = 0; i < seeded.length; i++) {
    seeded[i].seed = i + 1;
  }

  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  t.entrants = seeded;

  // Reset derived items
  t.groups = [];
  t.matches = [];
  t.playoffDefaultVenue = "";
  t.championName = "";

  await t.save();
  return t;
}

// ------------------------------
// Balanced Groups (Snake seeding)
// ------------------------------
export async function generateGroupsSeeded(tournamentId, { groupCount, groupSize, randomize }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  if (!t.entrants || t.entrants.length < 2) {
    throw new Error("Entrants not set");
  }

  const list = t.entrants.slice();

  let count;
  const n = list.length;

  if (groupSize && Number(groupSize) > 0) {
    const sz = Math.max(1, Number(groupSize));
    count = Math.ceil(n / sz);
  } else {
    count = Math.max(2, Number(groupCount || t.groupCount || 2));
    count = Math.min(count, n);
  }

  // seeded strongest -> weakest
  const seeded = list.slice().sort((a, b) => (a.seed || 9999) - (b.seed || 9999));

  // Optional randomize: ONLY random within same seed bands? (simple version: shuffle all)
  // For BEST UX, keep randomize=false to keep fairness.
  // We'll implement: if randomize true -> shuffle but keep seed numbers stable.
  if (randomize) {
    seeded.sort(() => Math.random() - 0.5);
  }

  const groups = [];
  for (let i = 0; i < count; i++) {
    const id = groupIdFromIndex(i);
    groups.push({ id, name: `Group ${id}`, members: [] });
  }

  // Snake seeding distribution
  // Forward then reverse every row
  let forward = true;
  let idx = 0;

  while (idx < seeded.length) {
    if (forward) {
      for (let g = 0; g < groups.length && idx < seeded.length; g++) {
        groups[g].members.push(seeded[idx].entrantId);
        idx++;
      }
    } else {
      for (let g = groups.length - 1; g >= 0 && idx < seeded.length; g--) {
        groups[g].members.push(seeded[idx].entrantId);
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
  t.playoffDefaultVenue = "";
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

  // remove old matches (both group & playoffs) for regenerate behavior
  t.matches = [];
  t.playoffDefaultVenue = "";
  t.championName = "";

  const matches = [];

  for (const g of t.groups) {
    const members = (g.members || []).map((x) => String(x));
    let counter = 1;

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        matches.push({
          id: `g_${g.id}_${counter}`,
          teamAId: members[i],
          teamBId: members[j],
          teamAName: "",
          teamBName: "",
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

  // Fill names from entrants
  const nameById = new Map((t.entrants || []).map((e) => [String(e.entrantId), e.name]));
  for (const m of matches) {
    m.teamAName = nameById.get(String(m.teamAId)) || "Player";
    m.teamBName = nameById.get(String(m.teamBId)) || "Player";
  }

  t.matches = matches;
  await t.save();
  return t;
}

// ------------------------------
// Standings + Playoffs generation
// ------------------------------
function computeGroupStandings(t) {
  // returns map gid -> row[]
  const byGroup = new Map();

  for (const g of t.groups || []) {
    const rows = new Map();
    for (const memberId of g.members || []) {
      const id = String(memberId);
      const entrant = (t.entrants || []).find((e) => String(e.entrantId) === id);
      rows.set(id, {
        id,
        name: entrant?.name || "Player",
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

    const a = groupRows.get(String(m.teamAId));
    const b = groupRows.get(String(m.teamBId));
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

export async function generatePlayoffs(tournamentId, { defaultVenue }) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  if (t.format !== "group_stage") throw new Error("Tournament is not group_stage");
  if (!t.groups || t.groups.length === 0) throw new Error("Groups not generated");

  t.playoffDefaultVenue = String(defaultVenue || "").trim();

  // If no group matches exist, generate them first (best UX)
  const hasGroupMatches = (t.matches || []).some((m) => isGroupMatchId(m.id));
  if (!hasGroupMatches) {
    await generateGroupMatches(tournamentId, { defaultVenue });
    // reload after save
    const fresh = await Tournament.findById(tournamentId);
    if (!fresh) throw new Error("Tournament not found after group match generation");
    t.groups = fresh.groups;
    t.matches = fresh.matches;
    t.entrants = fresh.entrants;
  }

  // Remove old playoffs
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

  // Interleave A1,B1,C1,A2,B2...
  const maxN = Object.values(qualifiersByGroup).reduce((m, list) => Math.max(m, list.length), 0);

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

  // Auto-progress based on BYEs (best UX)
  autoProgressFromRound(t, 1);
  await t.save();
  return t;
}

// ------------------------------
// Match update -> auto-progress + champion
// ------------------------------
export async function upsertMatch(tournamentId, matchUpdate) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new Error("Tournament not found");

  const id = String(matchUpdate?.id || "").trim();
  if (!id) throw new Error("Match id required");

  const idx = (t.matches || []).findIndex((m) => m.id === id);
  if (idx < 0) throw new Error("Match not found");

  const m = t.matches[idx];

  // Basic patch fields
  if (matchUpdate.teamAName !== undefined) m.teamAName = String(matchUpdate.teamAName || "");
  if (matchUpdate.teamBName !== undefined) m.teamBName = String(matchUpdate.teamBName || "");
  if (matchUpdate.venue !== undefined) m.venue = String(matchUpdate.venue || "");
  if (matchUpdate.dateTime !== undefined) m.dateTime = matchUpdate.dateTime ? new Date(matchUpdate.dateTime) : null;

  if (matchUpdate.scoreA !== undefined) m.scoreA = Number(matchUpdate.scoreA || 0);
  if (matchUpdate.scoreB !== undefined) m.scoreB = Number(matchUpdate.scoreB || 0);

  if (matchUpdate.status !== undefined) m.status = String(matchUpdate.status || "scheduled");

  // Validate playoff can’t draw (unless BYE involved)
  if (isPlayoffMatchId(m.id) && m.status === "played") {
    const aBye = String(m.teamAName || "").trim().toUpperCase() === "BYE";
    const bBye = String(m.teamBName || "").trim().toUpperCase() === "BYE";
    if (!aBye && !bBye && m.scoreA === m.scoreB) {
      throw new Error("Playoff matches cannot end in a draw");
    }
  }

  // IMPORTANT: if playoff match edited, clear future rounds and auto-progress
  if (isPlayoffMatchId(m.id)) {
    const r = playoffRoundOf(m.id);
    if (r != null) {
      clearPlayoffRoundsAfter(t, r);
      // keep rounds up to r (including this match), then progress forward
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
