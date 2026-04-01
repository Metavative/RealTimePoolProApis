import PrizeAward from "../models/prizeAward.model.js";
import User from "../models/user.model.js";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function achievementsEnabled() {
  return boolFromEnv("FEATURE_ACHIEVEMENTS_V2", false);
}

function asNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asInt(v, fallback = 0) {
  return Math.round(asNum(v, fallback));
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

const MILESTONES = Object.freeze([
  {
    code: "FIRST_MATCH",
    title: "First Break",
    description: "Completed your first match.",
    kind: "CUP",
    reached: (m) => m.totalMatches >= 1,
  },
  {
    code: "WIN_10",
    title: "Win Starter",
    description: "Won 10 matches.",
    kind: "CUP",
    reached: (m) => m.gamesWon >= 10,
  },
  {
    code: "WIN_50",
    title: "Win Master",
    description: "Won 50 matches.",
    kind: "PRIZE",
    reached: (m) => m.gamesWon >= 50,
  },
  {
    code: "LEVEL_5",
    title: "Level 5 Reached",
    description: "Reached level 5.",
    kind: "BADGE",
    reached: (m) => m.highestLevel >= 5,
  },
  {
    code: "LEVEL_10",
    title: "Level 10 Reached",
    description: "Reached level 10.",
    kind: "PRIZE",
    reached: (m) => m.highestLevel >= 10,
  },
  {
    code: "EARN_500",
    title: "Earnings Starter",
    description: "Total winnings reached 500.",
    kind: "CUP",
    reached: (m) => m.totalWinnings >= 500,
  },
  {
    code: "EARN_2500",
    title: "Earnings Pro",
    description: "Total winnings reached 2500.",
    kind: "PRIZE",
    reached: (m) => m.totalWinnings >= 2500,
  },
]);

function metricsFromUser(user = {}) {
  const stats = user?.stats || {};
  const profile = user?.profile || {};
  return {
    totalMatches: asInt(stats.totalMatches, asInt(stats.gamesWon, 0) + asInt(stats.gamesLost, 0) + asInt(stats.gamesDrawn, 0)),
    gamesWon: asInt(stats.gamesWon, 0),
    totalWinnings: Math.max(asNum(stats.totalWinnings, 0), asNum(user?.earnings?.career, 0)),
    highestLevel: Math.max(
      asInt(stats.highestLevelAchieved, 1),
      asInt(profile.highestLevelAchieved, 1),
      1
    ),
  };
}

export async function evaluateAndAwardMilestones({
  userId,
  trigger = "SYSTEM",
  sourceModule = "OTHER",
  sourceRefId = "",
} = {}) {
  if (!achievementsEnabled()) {
    return { ok: true, enabled: false, created: [] };
  }
  const uid = cleanString(userId);
  if (!uid) return { ok: false, enabled: true, created: [], reason: "missing_user_id" };

  const user = await User.findById(uid)
    .select("stats profile earnings")
    .lean();
  if (!user) return { ok: false, enabled: true, created: [], reason: "user_not_found" };

  const metrics = metricsFromUser(user);
  const eligible = MILESTONES.filter((m) => {
    try {
      return !!m.reached(metrics);
    } catch (_) {
      return false;
    }
  });
  if (!eligible.length) return { ok: true, enabled: true, created: [] };

  const existing = await PrizeAward.find({
    userId: uid,
    code: { $in: eligible.map((m) => upper(m.code)) },
  })
    .select("code")
    .lean();
  const existingCodes = new Set(existing.map((x) => upper(x.code)));
  const toCreate = eligible.filter((m) => !existingCodes.has(upper(m.code)));
  if (!toCreate.length) return { ok: true, enabled: true, created: [] };

  const now = new Date();
  const docs = toCreate.map((m) => ({
    awardId: generatePublicId("AWD"),
    userId: uid,
    code: upper(m.code),
    title: cleanString(m.title),
    description: cleanString(m.description),
    kind: upper(m.kind, "CUP"),
    trigger: upper(trigger || "SYSTEM"),
    sourceModule: upper(sourceModule || "OTHER"),
    sourceRefId: cleanString(sourceRefId),
    awardedAt: now,
    metadata: { metrics },
  }));

  const created = await PrizeAward.insertMany(docs, { ordered: false });

  return {
    ok: true,
    enabled: true,
    created: created.map((row) => ({
      awardId: cleanString(row.awardId),
      code: upper(row.code),
      title: cleanString(row.title),
      kind: upper(row.kind),
      awardedAt: row.awardedAt || null,
    })),
  };
}
