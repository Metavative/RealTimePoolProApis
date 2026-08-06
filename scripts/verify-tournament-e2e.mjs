// End-to-end verification against a REAL running backend, over HTTP, through
// the exact routes the Flutter app calls (real auth middleware included).
//
// This exists because controller-level tests can pass while route wiring,
// middleware or payload shapes are broken. Run it before handing a build to a
// tester.
//
// Usage:
//   1) start a backend against an ISOLATED db:
//        MONGO_DB_NAME=poolpro_verify PORT=4100 node src/index.js
//   2) node scripts/verify-tournament-e2e.mjs
//
// Safe: only ever writes to the database the server was pointed at. Point it at
// poolpro_verify (or any scratch db), never production.

import "dotenv/config";
import mongoose from "mongoose";

const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:4100";
const DB_NAME = process.env.MONGO_DB_NAME || "poolpro_verify";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("MONGO_URI missing (.env)");
  process.exit(1);
}
if (DB_NAME === "poolpro") {
  console.error("Refusing to run against the production database 'poolpro'.");
  process.exit(1);
}

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

// Controllers reply as { data } or raw — unwrap either.
function unwrap(r) {
  const b = r.body;
  if (b && typeof b === "object" && b.data !== undefined) return b.data;
  return b;
}

console.log(`\n=== E2E verification: ${BASE} (db: ${DB_NAME}) ===\n`);

await mongoose.connect(MONGO_URI, { dbName: DB_NAME });

const Club = (await import("../src/models/club.model.js")).default;
const User = (await import("../src/models/user.model.js")).default;
const Tournament = (await import("../src/models/tournament.model.js")).default;
const { sign } = await import("../src/services/jwtService.js");

// ---- fixtures -------------------------------------------------------------
const stamp = String(process.hrtime.bigint()).slice(-9);

const owner = await User.create({
  username: `e2e_owner_${stamp}`,
  email: `e2e_owner_${stamp}@example.test`,
  profile: { nickname: "E2E Owner", role: "USER" },
});

const club = await Club.create({
  name: `E2E Club ${stamp}`,
  email: `e2e_club_${stamp}@example.test`,
  owner: owner._id,
  status: "ACTIVE",
});

const clubToken = sign({ id: String(club._id), typ: "club_access", role: "CLUB" });

const players = [];
for (let i = 1; i <= 4; i++) {
  players.push(
    await User.create({
      username: `e2e_p${i}_${stamp}`,
      email: `e2e_p${i}_${stamp}@privatemail.test`,
      phone: `0770090${stamp.slice(-4)}${i}`,
      profile: { nickname: `E2E Player ${i}`, role: "USER" },
    })
  );
}
const playerToken = sign({ id: String(players[0]._id), userId: String(players[0]._id) });

// ==========================================================================
console.log("[1] Knockout lifecycle through the real routes");
// ==========================================================================

const created = await api("POST", "/api/tournaments", {
  token: clubToken,
  body: { name: `E2E Knockout ${stamp}`, format: "knockout" },
});
check("create tournament returns 2xx", created.status >= 200 && created.status < 300, `status ${created.status}`);
const tid = String(unwrap(created)?._id || unwrap(created)?.id || "");
check("tournament id returned", tid.length > 0);

if (tid) {
  const ent = await api("POST", `/api/tournaments/${tid}/entrants`, {
    token: clubToken,
    body: {
      entrants: players.map((p) => ({
        participantKey: `uid:${p._id}`,
        userId: String(p._id),
        name: p.profile.nickname,
      })),
    },
  });
  check("set entrants 2xx", ent.status >= 200 && ent.status < 300, `status ${ent.status} ${JSON.stringify(ent.body).slice(0, 160)}`);

  const gen = await api("POST", `/api/tournaments/${tid}/matches/generate`, {
    token: clubToken,
    body: { format: "knockout" },
  });
  check("generate matches 2xx", gen.status >= 200 && gen.status < 300, `status ${gen.status} ${JSON.stringify(gen.body).slice(0, 160)}`);

  let t = unwrap(await api("GET", `/api/tournaments/${tid}`, { token: clubToken }));
  let ko = (t?.matches || []).filter((m) => String(m.id).startsWith("ko_"));
  check("4 players produce a 3-match bracket", ko.length === 3, `got ${ko.length}: ${ko.map((m) => m.id).join(",")}`);
  check("the FINAL exists up front", ko.some((m) => m.id === "ko_r2_1"));
  check(
    "final starts as TBD vs TBD",
    ko.find((m) => m.id === "ko_r2_1")?.teamA === "TBD",
    JSON.stringify(ko.find((m) => m.id === "ko_r2_1"))
  );

  // Play the two semi-finals.
  for (const mid of ["ko_r1_1", "ko_r1_2"]) {
    const r = await api("PATCH", `/api/tournaments/${tid}/matches`, {
      token: clubToken,
      body: { id: mid, scoreA: 3, scoreB: 1, status: "played" },
    });
    check(`record result for ${mid}`, r.status >= 200 && r.status < 300, `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }

  t = unwrap(await api("GET", `/api/tournaments/${tid}`, { token: clubToken }));
  ko = (t?.matches || []).filter((m) => String(m.id).startsWith("ko_"));
  const semi1 = ko.find((m) => m.id === "ko_r1_1");
  const semi2 = ko.find((m) => m.id === "ko_r1_2");
  const final = ko.find((m) => m.id === "ko_r2_1");

  check("semi 1 winner advanced into the final", final?.teamA === semi1?.teamA, `final.teamA=${final?.teamA} semi1.teamA=${semi1?.teamA}`);
  check("semi 2 winner advanced into the final", final?.teamB === semi2?.teamA, `final.teamB=${final?.teamB} semi2.teamA=${semi2?.teamA}`);
  check("finalists have readable names", final?.teamAName && final.teamAName !== "TBD" && final.teamAName !== "Player", `teamAName=${final?.teamAName}`);
  check("no champion before the final is played", !t?.championName);

  // A draw must be refused.
  const draw = await api("PATCH", `/api/tournaments/${tid}/matches`, {
    token: clubToken,
    body: { id: "ko_r2_1", scoreA: 2, scoreB: 2, status: "played" },
  });
  check("draw in the final is rejected", draw.status >= 400, `status ${draw.status}`);

  // Play the final.
  const fin = await api("PATCH", `/api/tournaments/${tid}/matches`, {
    token: clubToken,
    body: { id: "ko_r2_1", scoreA: 5, scoreB: 2, status: "played" },
  });
  check("record the final 2xx", fin.status >= 200 && fin.status < 300, `status ${fin.status}`);

  t = unwrap(await api("GET", `/api/tournaments/${tid}`, { token: clubToken }));
  check("champion decided", !!t?.championName, `championName=${t?.championName}`);
  check("champion is the final's winner", t?.championName === final?.teamA, `champion=${t?.championName}`);

  // Edit an earlier result -> must cascade.
  const flip = await api("PATCH", `/api/tournaments/${tid}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 0, scoreB: 4, status: "played" },
  });
  check("edit an earlier semi 2xx", flip.status >= 200 && flip.status < 300, `status ${flip.status}`);

  t = unwrap(await api("GET", `/api/tournaments/${tid}`, { token: clubToken }));
  const final2 = (t?.matches || []).find((m) => m.id === "ko_r2_1");
  check("final's participant updated after the edit", final2?.teamA === semi1?.teamB, `final.teamA=${final2?.teamA} expected=${semi1?.teamB}`);
  check("stale final result cleared", final2?.status !== "played", `status=${final2?.status}`);
  check("champion withdrawn until the final is replayed", !t?.championName, `championName=${t?.championName}`);
}

// ==========================================================================
console.log("\n[2] Player search — privacy");
// ==========================================================================

const byName = await api("GET", `/api/friend/search?q=e2e_p2_${stamp}`, { token: playerToken });
check("username search 2xx", byName.status === 200, `status ${byName.status}`);
const nameHits = Array.isArray(byName.body) ? byName.body : [];
check("username search finds the player", nameHits.length >= 1, `got ${nameHits.length}`);
check(
  "no email field in the payload",
  nameHits.every((h) => !("email" in h)),
  JSON.stringify(nameHits[0] || {})
);
check(
  "no phone field in the payload",
  nameHits.every((h) => !("phone" in h)),
  JSON.stringify(nameHits[0] || {})
);
check(
  "no email value leaks anywhere in the payload",
  !JSON.stringify(nameHits).includes("privatemail"),
  JSON.stringify(nameHits).slice(0, 200)
);

const byEmail = await api("GET", `/api/friend/search?q=privatemail`, { token: playerToken });
const emailHits = Array.isArray(byEmail.body) ? byEmail.body : [];
check("searching an email fragment finds nobody", emailHits.length === 0, `got ${emailHits.length}`);

const byPhone = await api("GET", `/api/friend/search?q=07700`, { token: playerToken });
const phoneHits = Array.isArray(byPhone.body) ? byPhone.body : [];
check("searching a phone fragment finds nobody", phoneHits.length === 0, `got ${phoneHits.length}`);

const wildcard = await api("GET", `/api/friend/search?q=.`, { token: playerToken });
const wildHits = Array.isArray(wildcard.body) ? wildcard.body : [];
check("'.' is literal, not a match-all wildcard", wildHits.length === 0, `got ${wildHits.length}`);

// ==========================================================================
console.log("\n[3] Group-stage format configuration");
// ==========================================================================

const gsCreate = await api("POST", "/api/tournaments", {
  token: clubToken,
  body: { name: `E2E Groups ${stamp}`, format: "group_stage" },
});
const gsId = String(unwrap(gsCreate)?._id || "");
check("create group-stage tournament", gsId.length > 0, `status ${gsCreate.status}`);

if (gsId) {
  await api("POST", `/api/tournaments/${gsId}/entrants`, {
    token: clubToken,
    body: {
      entrants: players.map((p) => ({
        participantKey: `uid:${p._id}`,
        userId: String(p._id),
        name: p.profile.nickname,
      })),
    },
  });

  const cfg = await api("POST", `/api/tournaments/${gsId}/format/configure`, {
    token: clubToken,
    body: { groupCount: 2, qualifiersPerGroup: 2, enableKnockoutStage: true },
  });
  check("configure format 2xx", cfg.status >= 200 && cfg.status < 300, `status ${cfg.status} ${JSON.stringify(cfg.body).slice(0, 160)}`);

  const gsT = unwrap(await api("GET", `/api/tournaments/${gsId}`, { token: clubToken }));
  check("groupCount persisted", Number(gsT?.formatConfig?.groupCount) === 2, `got ${gsT?.formatConfig?.groupCount}`);
  check("qualifiersPerGroup persisted", Number(gsT?.formatConfig?.qualifiersPerGroup) === 2, `got ${gsT?.formatConfig?.qualifiersPerGroup}`);

  const cfg3 = await api("POST", `/api/tournaments/${gsId}/format/configure`, {
    token: clubToken,
    body: { groupCount: 3, qualifiersPerGroup: 1, enableKnockoutStage: true },
  });
  check("reconfigure to a different group count 2xx", cfg3.status >= 200 && cfg3.status < 300, `status ${cfg3.status}`);
  const gsT3 = unwrap(await api("GET", `/api/tournaments/${gsId}`, { token: clubToken }));
  check("changed groupCount persisted", Number(gsT3?.formatConfig?.groupCount) === 3, `got ${gsT3?.formatConfig?.groupCount}`);
}

// ==========================================================================
console.log("\n[4] Every format generates and plays out (regression sweep)");
// ==========================================================================

// Knockout shares bracket helpers with double-elim and is also used by
// "killer", so a change to one can silently break the others.
const entrantsBody = {
  entrants: players.map((p) => ({
    participantKey: `uid:${p._id}`,
    userId: String(p._id),
    name: p.profile.nickname,
  })),
};

for (const fmt of ["round_robin", "knockout", "double_elimination", "killer"]) {
  const c1 = await api("POST", "/api/tournaments", {
    token: clubToken,
    body: { name: `E2E ${fmt} ${stamp}`, format: fmt },
  });
  const fid = String(unwrap(c1)?._id || "");
  if (!fid) {
    check(`[${fmt}] create`, false, `status ${c1.status}`);
    continue;
  }

  await api("POST", `/api/tournaments/${fid}/entrants`, { token: clubToken, body: entrantsBody });
  const g = await api("POST", `/api/tournaments/${fid}/matches/generate`, {
    token: clubToken,
    body: { format: fmt },
  });
  check(`[${fmt}] generate matches 2xx`, g.status >= 200 && g.status < 300, `status ${g.status}`);

  let doc = unwrap(await api("GET", `/api/tournaments/${fid}`, { token: clubToken }));
  check(`[${fmt}] produced matches`, (doc?.matches || []).length > 0, `got ${(doc?.matches || []).length}`);

  // Play everything that is playable, repeatedly, until nothing is left.
  const isReal = (k) => k && !["BYE", "TBD", ""].includes(String(k).trim().toUpperCase());
  let guard = 0;
  while (guard++ < 40) {
    doc = unwrap(await api("GET", `/api/tournaments/${fid}`, { token: clubToken }));
    const next = (doc?.matches || []).find(
      (m) => m.status !== "played" && isReal(m.teamA) && isReal(m.teamB)
    );
    if (!next) break;
    const r = await api("PATCH", `/api/tournaments/${fid}/matches`, {
      token: clubToken,
      body: { id: next.id, scoreA: 2, scoreB: 1, status: "played" },
    });
    if (r.status < 200 || r.status >= 300) {
      check(`[${fmt}] play ${next.id}`, false, `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      break;
    }
  }
  check(`[${fmt}] played out without stalling`, guard < 40, `hit the guard after ${guard} iterations`);

  doc = unwrap(await api("GET", `/api/tournaments/${fid}`, { token: clubToken }));
  const leftover = (doc?.matches || []).filter(
    (m) => m.status !== "played" && isReal(m.teamA) && isReal(m.teamB)
  );
  check(`[${fmt}] no playable match left unplayed`, leftover.length === 0, `${leftover.map((m) => m.id).join(",")}`);

  // Elimination formats must crown someone; round robin has no champion concept.
  if (fmt !== "round_robin") {
    check(`[${fmt}] champion decided`, !!doc?.championName, `championName=${doc?.championName || "(empty)"}`);
  }

  await Tournament.deleteOne({ _id: fid });
}

// ==========================================================================
console.log("\n[5] Group stage: groups + group matches generate");
// ==========================================================================

if (gsId) {
  const gg = await api("POST", `/api/tournaments/${gsId}/groups/generate`, {
    token: clubToken,
    body: { groupCount: 2, randomize: false },
  });
  check("generate groups 2xx", gg.status >= 200 && gg.status < 300, `status ${gg.status} ${JSON.stringify(gg.body).slice(0, 160)}`);

  const gm = await api("POST", `/api/tournaments/${gsId}/matches/generate-group`, {
    token: clubToken,
    body: {},
  });
  check("generate group matches 2xx", gm.status >= 200 && gm.status < 300, `status ${gm.status} ${JSON.stringify(gm.body).slice(0, 160)}`);

  const gsDoc = unwrap(await api("GET", `/api/tournaments/${gsId}`, { token: clubToken }));
  check("groups created", (gsDoc?.groups || []).length === 2, `got ${(gsDoc?.groups || []).length}`);
  check(
    "group matches created",
    (gsDoc?.matches || []).some((m) => String(m.id).startsWith("g_")),
    `ids: ${(gsDoc?.matches || []).map((m) => m.id).slice(0, 6).join(",")}`
  );
}

// ==========================================================================
console.log("\n[6] Tournament edge cases");
// ==========================================================================

async function mkKnockout(nPlayers, label) {
  const c1 = await api("POST", "/api/tournaments", {
    token: clubToken,
    body: { name: `E2E ${label} ${stamp}`, format: "knockout" },
  });
  const id = String(unwrap(c1)?._id || "");
  if (!id) return null;
  await api("POST", `/api/tournaments/${id}/entrants`, {
    token: clubToken,
    body: {
      entrants: players.slice(0, nPlayers).map((p) => ({
        participantKey: `uid:${p._id}`,
        userId: String(p._id),
        name: p.profile.nickname,
      })),
    },
  });
  await api("POST", `/api/tournaments/${id}/matches/generate`, {
    token: clubToken,
    body: { format: "knockout" },
  });
  return id;
}

// 2 players: the smallest possible bracket is a single final.
const twoId = await mkKnockout(2, "KO2");
if (twoId) {
  const d = unwrap(await api("GET", `/api/tournaments/${twoId}`, { token: clubToken }));
  const ko = (d?.matches || []).filter((m) => String(m.id).startsWith("ko_"));
  check("[2 players] exactly one match", ko.length === 1, `got ${ko.length}`);
  await api("PATCH", `/api/tournaments/${twoId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 2, scoreB: 0, status: "played" },
  });
  const d2 = unwrap(await api("GET", `/api/tournaments/${twoId}`, { token: clubToken }));
  check("[2 players] champion decided", !!d2?.championName, `${d2?.championName}`);
  await Tournament.deleteOne({ _id: twoId });
}

// 3 players: one bye, which must advance without being played.
const threeId = await mkKnockout(3, "KO3");
if (threeId) {
  const d = unwrap(await api("GET", `/api/tournaments/${threeId}`, { token: clubToken }));
  const ko = (d?.matches || []).filter((m) => String(m.id).startsWith("ko_"));
  const byeMatch = ko.find((m) => [m.teamA, m.teamB].includes("BYE"));
  const final = ko.find((m) => m.id === "ko_r2_1");
  check("[3 players] a bye exists in round 1", !!byeMatch);
  const advanced = byeMatch && (byeMatch.teamA === "BYE" ? byeMatch.teamB : byeMatch.teamA);
  check(
    "[3 players] bye recipient is already in the final",
    !!final && [final.teamA, final.teamB].includes(advanced),
    `final=${final?.teamA}/${final?.teamB} advanced=${advanced}`
  );
  check("[3 players] the bye match is not marked played", byeMatch?.status !== "played");
  await Tournament.deleteOne({ _id: threeId });
}

// Scoring an undecided slot must be refused by the SERVER, not just the app.
const tbdId = await mkKnockout(4, "KOTBD");
if (tbdId) {
  const r = await api("PATCH", `/api/tournaments/${tbdId}/matches`, {
    token: clubToken,
    body: { id: "ko_r2_1", scoreA: 3, scoreB: 1, status: "played" },
  });
  check("scoring a TBD slot is rejected server-side", r.status >= 400, `status ${r.status}`);

  const d = unwrap(await api("GET", `/api/tournaments/${tbdId}`, { token: clubToken }));
  const fin = (d?.matches || []).find((m) => m.id === "ko_r2_1");
  check("the TBD slot was not corrupted", fin?.status !== "played" && fin?.teamA === "TBD", JSON.stringify(fin));
  await Tournament.deleteOne({ _id: tbdId });
}

// Changing the roster after generation must clear the stale bracket.
const rosterId = await mkKnockout(4, "KOROSTER");
if (rosterId) {
  await api("PATCH", `/api/tournaments/${rosterId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 2, scoreB: 0, status: "played" },
  });
  const shrink = await api("POST", `/api/tournaments/${rosterId}/entrants`, {
    token: clubToken,
    body: {
      entrants: players.slice(0, 3).map((p) => ({
        participantKey: `uid:${p._id}`,
        userId: String(p._id),
        name: p.profile.nickname,
      })),
    },
  });
  check("roster can be changed before start", shrink.status >= 200 && shrink.status < 300, `status ${shrink.status}`);
  const d = unwrap(await api("GET", `/api/tournaments/${rosterId}`, { token: clubToken }));
  check(
    "stale bracket cleared after a roster change",
    (d?.matches || []).length === 0,
    `${(d?.matches || []).length} matches survived`
  );
  check("stale champion cleared after a roster change", !d?.championName);
  await Tournament.deleteOne({ _id: rosterId });
}

// A tournament with fewer than 2 entrants must not generate a bracket.
const oneCreate = await api("POST", "/api/tournaments", {
  token: clubToken,
  body: { name: `E2E KO1 ${stamp}`, format: "knockout" },
});
const oneId = String(unwrap(oneCreate)?._id || "");
if (oneId) {
  await api("POST", `/api/tournaments/${oneId}/entrants`, {
    token: clubToken,
    body: {
      entrants: [
        { participantKey: `uid:${players[0]._id}`, userId: String(players[0]._id), name: "solo" },
      ],
    },
  });
  const g = await api("POST", `/api/tournaments/${oneId}/matches/generate`, {
    token: clubToken,
    body: { format: "knockout" },
  });
  check("generating with 1 entrant is refused", g.status >= 400, `status ${g.status}`);
  await Tournament.deleteOne({ _id: oneId });
}

// ==========================================================================
console.log("\n[6b] Match length (race to N frames)");
// ==========================================================================

const raceId = await mkKnockout(4, "KORACE");
if (raceId) {
  // Set a tournament-wide race to 5.
  const cfg = await api("POST", `/api/tournaments/${raceId}/format/configure`, {
    token: clubToken,
    body: { raceTo: 5 },
  });
  check("set tournament match length 2xx", cfg.status >= 200 && cfg.status < 300, `status ${cfg.status}`);
  let d = unwrap(await api("GET", `/api/tournaments/${raceId}`, { token: clubToken }));
  check("raceTo persisted", Number(d?.formatConfig?.raceTo) === 5, `got ${d?.formatConfig?.raceTo}`);

  // A partial configure must not clobber the other format flags.
  check(
    "partial configure preserved enableKnockoutStage",
    d?.formatConfig?.enableKnockoutStage === true,
    `got ${d?.formatConfig?.enableKnockoutStage}`
  );

  // Wrong scores for a race to 5 must be refused.
  const short = await api("PATCH", `/api/tournaments/${raceId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 4, scoreB: 2, status: "played" },
  });
  check("4-2 rejected in a race to 5", short.status >= 400, `status ${short.status}`);

  const over = await api("PATCH", `/api/tournaments/${raceId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 7, scoreB: 2, status: "played" },
  });
  check("7-2 rejected in a race to 5", over.status >= 400, `status ${over.status}`);

  const both = await api("PATCH", `/api/tournaments/${raceId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 5, scoreB: 5, status: "played" },
  });
  check("5-5 rejected in a race to 5", both.status >= 400, `status ${both.status}`);

  const good = await api("PATCH", `/api/tournaments/${raceId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_1", scoreA: 5, scoreB: 3, status: "played" },
  });
  check("5-3 accepted in a race to 5", good.status >= 200 && good.status < 300, `status ${good.status}`);

  // Per-match override: make the second semi a race to 3.
  const ovr = await api("PATCH", `/api/tournaments/${raceId}/matches`, {
    token: clubToken,
    body: { id: "ko_r1_2", raceTo: 3, scoreA: 3, scoreB: 1, status: "played" },
  });
  check("per-match override (race to 3) accepted", ovr.status >= 200 && ovr.status < 300, `status ${ovr.status}`);

  d = unwrap(await api("GET", `/api/tournaments/${raceId}`, { token: clubToken }));
  const m2 = (d?.matches || []).find((m) => m.id === "ko_r1_2");
  check("per-match raceTo stored", Number(m2?.raceTo) === 3, `got ${m2?.raceTo}`);
  check("both semis played, final populated", (d?.matches || []).find((m) => m.id === "ko_r2_1")?.teamA !== "TBD");

  await Tournament.deleteOne({ _id: raceId });
}

// ==========================================================================
console.log("\n[7] Signup name validation");
// ==========================================================================

async function trySignup(first, last, i) {
  const r = await api("POST", "/api/auth/signup", {
    body: {
      role: "player",
      username: `e2esig${stamp.slice(-5)}${i}`,
      email: `e2e_signup_${stamp}_${i}@example.test`,
      password: "Passw0rd!23",
      firstName: first,
      lastName: last,
      gender: "male",
      age: 30,
    },
  });
  return r;
}

const nameCases = [
  ["John", "Smith", true],
  ["Mary Anne", "Van Der Berg", true],
  ["José", "Müller", true],
  ["A?B", "Smith", false],
];
let ni = 0;
for (const [first, last, shouldPass] of nameCases) {
  ni += 1;
  const r = await trySignup(first, last, ni);
  const body = JSON.stringify(r.body);
  const rejectedForName = body.toLowerCase().includes("invalid first/last name");
  if (shouldPass) {
    // Must actually get PAST name validation — assert success, not merely the
    // absence of the name error (an unrelated 400 would otherwise look like a
    // pass).
    check(
      `signup accepts "${first} ${last}"`,
      r.status >= 200 && r.status < 300,
      `status ${r.status} ${body.slice(0, 140)}`
    );
  } else {
    check(`signup rejects "${first} ${last}"`, rejectedForName, `status ${r.status} ${body.slice(0, 140)}`);
  }
}
await User.deleteMany({ email: { $regex: `^e2e_signup_${stamp}_` } });

// ==========================================================================
console.log("\n[8] Auth boundaries");
// ==========================================================================

const noAuth = await api("GET", `/api/tournaments/${tid}`);
check("tournament read requires auth", noAuth.status === 401, `status ${noAuth.status}`);

const playerOnClubRoute = await api("GET", `/api/tournaments/${tid}`, { token: playerToken });
check("a player token cannot use club routes", playerOnClubRoute.status === 403 || playerOnClubRoute.status === 401, `status ${playerOnClubRoute.status}`);

// ---- cleanup --------------------------------------------------------------
await Tournament.deleteMany({ clubId: club._id });
await Club.deleteOne({ _id: club._id });
await User.deleteMany({ _id: { $in: [owner._id, ...players.map((p) => p._id)] } });
await mongoose.disconnect();

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
