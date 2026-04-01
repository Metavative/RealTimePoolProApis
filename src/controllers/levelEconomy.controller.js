import mongoose from "mongoose";

import User from "../models/user.model.js";
import Transaction from "../models/transaction.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import WalletHold from "../models/walletHold.model.js";
import Settlement from "../models/settlement.model.js";
import LevelMatchSession from "../models/levelMatchSession.model.js";
import LevelMatchmakingState from "../models/levelMatchmakingState.model.js";
import { postReferralCommission } from "../services/referral.service.js";
import { evaluateAndAwardMilestones } from "../services/achievement.service.js";

const WINNER_SCORE_BONUS = 25;
const LOSER_SCORE_BONUS = 5;
const MONTH_COUNT = 12;

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function toId(v) {
  return cleanString(v);
}

function sameId(a, b) {
  return toId(a) === toId(b);
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function levelEconomyEnabled() {
  return boolFromEnv("FEATURE_LEVEL_ECONOMY_V2", false);
}

function matchmakingEnabled() {
  return boolFromEnv("FEATURE_MATCHMAKING_V2", false);
}

function levelCurrency() {
  return upper(process.env.LEVEL_CURRENCY, "GBP");
}

function levelMaxSupported() {
  const v = Number(process.env.LEVEL_MAX_SUPPORTED || 20);
  if (!Number.isFinite(v)) return 20;
  return Math.max(5, Math.min(40, Math.floor(v)));
}

function levelCommissionBps() {
  const v = Number(process.env.LEVEL_MATCH_COMMISSION_BPS || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(5000, Math.floor(v)));
}

function matchmakingDefaultRadiusKm() {
  const v = Number(process.env.MATCHMAKING_DEFAULT_RADIUS_KM || 15);
  if (!Number.isFinite(v)) return 15;
  return Math.max(1, Math.min(250, Math.floor(v)));
}

function matchmakingMaxRadiusKm() {
  const v = Number(process.env.MATCHMAKING_MAX_RADIUS_KM || 50);
  if (!Number.isFinite(v)) return 50;
  return Math.max(5, Math.min(500, Math.floor(v)));
}

function matchmakingLiveTtlSeconds() {
  const v = Number(process.env.MATCHMAKING_LIVE_TTL_SECONDS || 120);
  if (!Number.isFinite(v)) return 120;
  return Math.max(30, Math.min(3600, Math.floor(v)));
}

function normalizeLevel(raw) {
  const level = Math.floor(Number(raw || 0));
  if (!Number.isFinite(level) || level < 1) return 1;
  return Math.min(levelMaxSupported(), level);
}

function levelStakeMinor(level) {
  const safeLevel = normalizeLevel(level);
  return Math.floor(Math.pow(2, safeLevel - 1) * 100);
}

function toMinor(amountMajor) {
  const n = Number(amountMajor || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(Math.round(n * 100));
}

function toMajor(amountMinor) {
  const n = Number(amountMinor || 0);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function asNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolveUserLevel(user) {
  const profileLevel = Number(user?.profile?.highestLevelAchieved || 0);
  const statsLevel = Number(user?.stats?.highestLevelAchieved || 0);
  return normalizeLevel(Math.max(profileLevel, statsLevel, 1));
}

function userFallbackWalletMinor(user) {
  return toMinor(user?.earnings?.availableBalance || 0);
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000).toString().padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function walletAccountId(userId) {
  return cleanString(userId);
}

function levelMatchResponse(match) {
  return {
    sessionId: cleanString(match?.sessionId),
    level: Number(match?.level || 1),
    currency: upper(match?.currency || "GBP"),
    stakeMinor: Number(match?.stakeMinor || 0),
    totalPotMinor: Number(match?.totalPotMinor || 0),
    payoutMinor: Number(match?.payoutMinor || 0),
    commissionMinor: Number(match?.commissionMinor || 0),
    status: upper(match?.status || "CREATED"),
    challengerUserId: toId(match?.challengerUserId),
    opponentUserId: toId(match?.opponentUserId),
    winnerUserId: toId(match?.winnerUserId),
    loserUserId: toId(match?.loserUserId),
    settlementId: cleanString(match?.settlementId),
    ledgerSourceId: cleanString(match?.ledgerSourceId),
    startedAt: match?.startedAt || null,
    endedAt: match?.endedAt || null,
    cancelledAt: match?.cancelledAt || null,
    createdAt: match?.createdAt || null,
    updatedAt: match?.updatedAt || null,
  };
}

function getCoordinatePair(source = {}) {
  const coords = source?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function getUserCoordinatePair(user = {}) {
  const fromLocation = getCoordinatePair(user?.location || {});
  if (fromLocation) return fromLocation;
  const lat = Number(user?.profile?.latitude);
  const lng = Number(user?.profile?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function parseCoordinateInput(raw = {}) {
  const lat = Number(raw?.lat ?? raw?.latitude);
  const lng = Number(raw?.lng ?? raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function toRadians(v) {
  return (Number(v || 0) * Math.PI) / 180;
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return Math.round(R * c * 100) / 100;
}

function parseRadiusKm(raw, fallback = 15) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(matchmakingMaxRadiusKm(), Math.floor(n)));
}

function safeUsername(user = {}) {
  const username = cleanString(user?.username);
  if (username) return username;
  const nickname = cleanString(user?.profile?.nickname);
  if (nickname) return nickname;
  return "Player";
}

function availabilityResponse(state, user, extra = {}) {
  const geo = getCoordinatePair(state?.geo || {}) || getUserCoordinatePair(user || {});
  return {
    userId: toId(user?._id || state?.userId),
    username: safeUsername(user || {}),
    live: !!state?.live,
    status: upper(state?.status || (state?.live ? "LIVE" : "PAUSED")),
    preferredLevel: normalizeLevel(state?.preferredLevel || resolveUserLevel(user || {})),
    minLevel: normalizeLevel(state?.minLevel || user?.profile?.minLevel || 1),
    maxLevel: normalizeLevel(state?.maxLevel || user?.profile?.maxLevel || levelMaxSupported()),
    radiusKm: parseRadiusKm(state?.radiusKm, matchmakingDefaultRadiusKm()),
    autoAccept: !!state?.autoAccept,
    location: geo ? { lat: geo.lat, lng: geo.lng } : null,
    lastHeartbeatAt: state?.lastHeartbeatAt || null,
    updatedAt: state?.updatedAt || null,
    ...extra,
  };
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "LEVEL_ECONOMY_DISABLED",
    message: "Level economy module is currently disabled.",
  });
}

function matchmakingUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "MATCHMAKING_DISABLED",
    message: "Automated matchmaking is currently disabled.",
  });
}

const SUPPORTED_ACCOUNT_TYPES = new Set([
  "USER_WALLET",
  "ORGANIZER_BALANCE",
  "PLATFORM_REVENUE",
  "PRIZE_POOL",
  "REFERRAL_COMMISSION",
  "HOLD_BALANCE",
  "SYSTEM_ADJUSTMENT",
]);

function normalizeAccountType(v) {
  const x = upper(v);
  return SUPPORTED_ACCOUNT_TYPES.has(x) ? x : "";
}

async function getAccountBalanceMinor({ accountType, accountId, currency = "GBP", session = null }) {
  const at = normalizeAccountType(accountType);
  const aid = cleanString(accountId);
  if (!at || !aid) return 0;
  const agg = LedgerEntry.aggregate([
    {
      $match: {
        accountType: at,
        accountId: aid,
        currency: upper(currency, "GBP"),
        status: "POSTED",
      },
    },
    {
      $group: {
        _id: null,
        debitMinor: {
          $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] },
        },
        creditMinor: {
          $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] },
        },
      },
    },
  ]);
  if (session) agg.session(session);
  const rows = await agg;
  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

async function postBalancedLedgerEntries({ currency, sourceType, sourceId, lines, metadata, session = null }) {
  let debit = 0;
  let credit = 0;
  const docs = [];
  for (const line of lines || []) {
    const direction = upper(line?.direction);
    const accountType = normalizeAccountType(line?.accountType);
    const accountId = cleanString(line?.accountId);
    const amountMinor = Math.max(0, Math.floor(Number(line?.amountMinor || 0)));
    if (!["DEBIT", "CREDIT"].includes(direction) || !accountType || !accountId || amountMinor <= 0) {
      throw new Error("Invalid ledger line");
    }
    if (direction === "DEBIT") debit += amountMinor;
    if (direction === "CREDIT") credit += amountMinor;
    docs.push({
      entryId: generatePublicId("LE"),
      direction,
      accountType,
      accountId,
      amountMinor,
      currency: upper(currency || "GBP"),
      status: "POSTED",
      sourceType: upper(sourceType || "MANUAL"),
      sourceId: upper(sourceId || ""),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    });
  }
  if (debit <= 0 || credit <= 0 || debit !== credit) {
    throw new Error("Ledger is not balanced");
  }
  await LedgerEntry.insertMany(docs, session ? { session } : undefined);
}

function sessionActiveFilter() {
  return ["CREATED", "FUNDS_HELD", "ONGOING"];
}

function levelSummaryResponse(user, walletBalanceMinor) {
  const currentLevel = resolveUserLevel(user);
  const currentStakeMinor = levelStakeMinor(currentLevel);
  const nextLevel = Math.min(levelMaxSupported(), currentLevel + 1);
  return {
    currentLevel,
    currentStakeMinor,
    nextLevel,
    nextStakeMinor: levelStakeMinor(nextLevel),
    walletBalanceMinor,
    canChallengeAtCurrentLevel: walletBalanceMinor >= currentStakeMinor,
    currency: levelCurrency(),
  };
}

function normalizeYearToDateArray(raw) {
  const out = Array.from({ length: MONTH_COUNT }, () => 0);
  if (Array.isArray(raw)) {
    for (let i = 0; i < Math.min(MONTH_COUNT, raw.length); i += 1) {
      out[i] = Math.max(0, asNumber(raw[i], 0));
    }
  }
  return out;
}

function toObjectId(value) {
  const id = toId(value);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

async function hasActiveLevelSessionForUser(userId) {
  const oid = toObjectId(userId);
  if (!oid) return false;
  const count = await LevelMatchSession.countDocuments({
    participants: { $in: [oid] },
    status: { $in: sessionActiveFilter() },
  });
  return count > 0;
}

async function walletBalanceMinorForUser(user, currency = "GBP") {
  const userId = toId(user?._id);
  const ledgerBalance = await getAccountBalanceMinor({
    accountType: "USER_WALLET",
    accountId: walletAccountId(userId),
    currency,
  });
  return Math.max(ledgerBalance, userFallbackWalletMinor(user));
}

function normalizePreferredRange({ minLevel, maxLevel, preferredLevel, fallbackLevel }) {
  const minRaw = normalizeLevel(minLevel || fallbackLevel || 1);
  const maxRaw = normalizeLevel(maxLevel || fallbackLevel || levelMaxSupported());
  const safeMin = Math.min(minRaw, maxRaw);
  const safeMax = Math.max(minRaw, maxRaw);
  const preferred = normalizeLevel(preferredLevel || fallbackLevel || safeMin);
  const safePreferred = Math.min(safeMax, Math.max(safeMin, preferred));
  return { minLevel: safeMin, maxLevel: safeMax, preferredLevel: safePreferred };
}

async function collectMatchmakingCandidates({ actorUser, actorState, targetLevel, requestedRadiusKm, limit }) {
  const actorId = toId(actorUser?._id);
  const currency = levelCurrency();
  const stakeMinor = levelStakeMinor(targetLevel);
  const actorWalletMinor = await walletBalanceMinorForUser(actorUser, currency);
  if (actorWalletMinor < stakeMinor) {
    return {
      blocked: true,
      code: "INSUFFICIENT_LEVEL_FUNDS",
      message: "You do not have enough balance for this level challenge.",
      requiredStakeMinor: stakeMinor,
      actorWalletMinor,
      candidates: [],
    };
  }

  const effectiveRadiusKm = parseRadiusKm(
    requestedRadiusKm,
    parseRadiusKm(actorState?.radiusKm, matchmakingDefaultRadiusKm())
  );

  const freshSince = new Date(Date.now() - matchmakingLiveTtlSeconds() * 1000);
  const actorGeo = getCoordinatePair(actorState?.geo || {}) || getUserCoordinatePair(actorUser || {});

  const query = {
    userId: { $ne: actorId },
    live: true,
    status: "LIVE",
    minLevel: { $lte: targetLevel },
    maxLevel: { $gte: targetLevel },
    lastHeartbeatAt: { $gte: freshSince },
  };

  if (actorGeo) {
    query.geo = {
      $near: {
        $geometry: { type: "Point", coordinates: [actorGeo.lng, actorGeo.lat] },
        $maxDistance: effectiveRadiusKm * 1000,
      },
    };
  }

  const candidateStates = await LevelMatchmakingState.find(query)
    .sort({ lastHeartbeatAt: -1 })
    .limit(Math.max(1, Math.min(100, limit * 3)))
    .lean();

  if (!candidateStates.length) {
    return {
      blocked: false,
      requiredStakeMinor: stakeMinor,
      actorWalletMinor,
      candidates: [],
    };
  }

  const candidateObjectIds = candidateStates
    .map((row) => toObjectId(row.userId))
    .filter(Boolean);

  const users = await User.find({ _id: { $in: candidateObjectIds } })
    .select(
      [
        "username",
        "profile.nickname",
        "profile.highestLevelAchieved",
        "stats.highestLevelAchieved",
        "earnings.availableBalance",
        "location",
        "profile.latitude",
        "profile.longitude",
      ].join(" ")
    )
    .lean();
  const userMap = new Map(users.map((u) => [toId(u._id), u]));

  const activeAgg = await LevelMatchSession.aggregate([
    { $match: { status: { $in: sessionActiveFilter() }, participants: { $in: candidateObjectIds } } },
    { $unwind: "$participants" },
    { $match: { participants: { $in: candidateObjectIds } } },
    { $group: { _id: "$participants", c: { $sum: 1 } } },
  ]);
  const activeSet = new Set(activeAgg.map((r) => toId(r._id)));

  const output = [];
  for (const state of candidateStates) {
    const userId = toId(state.userId);
    if (!userId || activeSet.has(userId) || sameId(userId, actorId)) continue;

    const user = userMap.get(userId);
    if (!user) continue;

    const candidateLevel = resolveUserLevel(user);
    if (candidateLevel !== targetLevel) continue;

    const candidateWalletMinor = await walletBalanceMinorForUser(user, currency);
    if (candidateWalletMinor < stakeMinor) continue;

    const candidateGeo = getCoordinatePair(state.geo || {}) || getUserCoordinatePair(user || {});
    const km = actorGeo && candidateGeo ? distanceKm(actorGeo, candidateGeo) : null;
    if (km !== null && km > effectiveRadiusKm) continue;

    output.push({
      userId,
      username: safeUsername(user),
      level: candidateLevel,
      walletBalanceMinor: candidateWalletMinor,
      distanceKm: km,
      location: candidateGeo ? { lat: candidateGeo.lat, lng: candidateGeo.lng } : null,
      liveSince: state.updatedAt || state.createdAt || null,
      autoAccept: !!state.autoAccept,
    });

    if (output.length >= limit) break;
  }

  output.sort((a, b) => {
    const ad = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.MAX_SAFE_INTEGER;
    const bd = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return String(a.username || "").localeCompare(String(b.username || ""));
  });

  return {
    blocked: false,
    requiredStakeMinor: stakeMinor,
    actorWalletMinor,
    radiusKm: effectiveRadiusKm,
    candidates: output,
  };
}

export async function myLevelEconomySummary(req, res) {
  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const user = await User.findById(userId)
      .select("profile.highestLevelAchieved stats.highestLevelAchieved earnings.availableBalance")
      .lean();
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const ledgerBalance = await getAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency: levelCurrency(),
    });
    const effectiveWalletMinor = Math.max(ledgerBalance, userFallbackWalletMinor(user));

    const activeSessions = await LevelMatchSession.countDocuments({
      participants: { $in: [new mongoose.Types.ObjectId(userId)] },
      status: { $in: sessionActiveFilter() },
    });

    return res.json({
      ok: true,
      levelEconomy: levelSummaryResponse(user, effectiveWalletMinor),
      activeSessions,
      featureEnabled: levelEconomyEnabled(),
      serverTimeMs: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load level economy summary",
    });
  }
}

export async function createLevelChallenge(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);

  const actorId = toId(req.userId);
  const opponentId = toId(req.body?.opponentUserId || req.body?.opponentId);
  if (!actorId) return res.status(401).json({ ok: false, message: "Unauthorized" });
  if (!opponentId || !mongoose.Types.ObjectId.isValid(opponentId)) {
    return res.status(400).json({ ok: false, message: "Valid opponentUserId is required" });
  }
  if (sameId(actorId, opponentId)) {
    return res.status(400).json({ ok: false, message: "You cannot challenge yourself" });
  }

  const [challenger, opponent] = await Promise.all([
    User.findById(actorId)
      .select("profile.highestLevelAchieved stats.highestLevelAchieved earnings.availableBalance")
      .lean(),
    User.findById(opponentId)
      .select("profile.highestLevelAchieved stats.highestLevelAchieved earnings.availableBalance")
      .lean(),
  ]);
  if (!challenger || !opponent) {
    return res.status(404).json({ ok: false, message: "Player not found" });
  }

  const challengerLevel = resolveUserLevel(challenger);
  const opponentLevel = resolveUserLevel(opponent);
  const level = normalizeLevel(req.body?.level || challengerLevel);

  if (level !== challengerLevel || level !== opponentLevel) {
    return res.status(400).json({
      ok: false,
      code: "LEVEL_MISMATCH",
      message: "Both players must challenge at the same current level.",
      levelInfo: { requestedLevel: level, challengerLevel, opponentLevel },
    });
  }

  const existing = await LevelMatchSession.findOne({
    participants: { $all: [actorId, opponentId] },
    status: { $in: sessionActiveFilter() },
  }).lean();
  if (existing) {
    return res.status(409).json({
      ok: false,
      code: "ACTIVE_LEVEL_MATCH_EXISTS",
      message: "There is already an active level match between these players.",
      match: levelMatchResponse(existing),
    });
  }

  const stakeMinor = levelStakeMinor(level);
  const totalPotMinor = stakeMinor * 2;
  const currency = levelCurrency();

  const challengerLedgerBalance = await getAccountBalanceMinor({
    accountType: "USER_WALLET",
    accountId: walletAccountId(actorId),
    currency,
  });
  const opponentLedgerBalance = await getAccountBalanceMinor({
    accountType: "USER_WALLET",
    accountId: walletAccountId(opponentId),
    currency,
  });

  const challengerWalletMinor = Math.max(challengerLedgerBalance, userFallbackWalletMinor(challenger));
  const opponentWalletMinor = Math.max(opponentLedgerBalance, userFallbackWalletMinor(opponent));
  if (challengerWalletMinor < stakeMinor || opponentWalletMinor < stakeMinor) {
    return res.status(400).json({
      ok: false,
      code: "INSUFFICIENT_LEVEL_FUNDS",
      message: "One or both players do not have enough wallet balance for this level.",
      requiredStakeMinor: stakeMinor,
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const sessionId = generatePublicId("LM");
    const challengerHoldId = generatePublicId("HOLD");
    const opponentHoldId = generatePublicId("HOLD");
    const challengerHoldAccountId = upper(`LMH_${sessionId}_A`);
    const opponentHoldAccountId = upper(`LMH_${sessionId}_B`);

    const levelMatchRows = await LevelMatchSession.create(
      [
        {
          sessionId,
          participants: [actorId, opponentId],
          challengerUserId: actorId,
          opponentUserId: opponentId,
          createdByUserId: actorId,
          level,
          currency,
          stakeMinor,
          totalPotMinor,
          status: "FUNDS_HELD",
          challengerHoldId,
          opponentHoldId,
          challengerHoldAccountId,
          opponentHoldAccountId,
        },
      ],
      { session }
    );
    const levelMatch = levelMatchRows[0];

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await WalletHold.create(
      [
        {
          holdId: challengerHoldId,
          userId: actorId,
          currency,
          amountMinor: stakeMinor,
          status: "HELD",
          reason: `Level ${level} match stake`,
          targetAccountType: "PRIZE_POOL",
          targetAccountId: sessionId,
          expiresAt,
        },
        {
          holdId: opponentHoldId,
          userId: opponentId,
          currency,
          amountMinor: stakeMinor,
          status: "HELD",
          reason: `Level ${level} match stake`,
          targetAccountType: "PRIZE_POOL",
          targetAccountId: sessionId,
          expiresAt,
        },
      ],
      { session }
    );

    await postBalancedLedgerEntries({
      currency,
      sourceType: "HOLD",
      sourceId: sessionId,
      session,
      metadata: { operation: "LEVEL_MATCH_STAKE_HOLD", level },
      lines: [
        {
          direction: "DEBIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(actorId),
          amountMinor: stakeMinor,
        },
        {
          direction: "CREDIT",
          accountType: "HOLD_BALANCE",
          accountId: challengerHoldAccountId,
          amountMinor: stakeMinor,
        },
        {
          direction: "DEBIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(opponentId),
          amountMinor: stakeMinor,
        },
        {
          direction: "CREDIT",
          accountType: "HOLD_BALANCE",
          accountId: opponentHoldAccountId,
          amountMinor: stakeMinor,
        },
      ],
    });

    const stakeMajor = toMajor(stakeMinor);
    await User.updateMany(
      { _id: { $in: [actorId, opponentId] } },
      {
        $inc: {
          "earnings.availableBalance": -stakeMajor,
          "earnings.entryFeesPaid": stakeMajor,
        },
      },
      { session }
    );

    await Transaction.create(
      [
        {
          user: actorId,
          amount: stakeMajor,
          type: "entry_fee",
          status: "completed",
          meta: { levelSessionId: sessionId, level },
        },
        {
          user: opponentId,
          amount: stakeMajor,
          type: "entry_fee",
          status: "completed",
          meta: { levelSessionId: sessionId, level },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      ok: true,
      message: "Level challenge created and stakes held.",
      match: levelMatchResponse(levelMatch),
    });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create level challenge",
    });
  }
}

export async function startLevelMatch(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);
  try {
    const actorId = toId(req.userId);
    const sessionId = upper(req.params.sessionId || req.body?.sessionId);
    if (!actorId) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId is required" });

    const levelMatch = await LevelMatchSession.findOne({ sessionId });
    if (!levelMatch) return res.status(404).json({ ok: false, message: "Level match not found" });
    if (!levelMatch.participants.some((p) => sameId(p, actorId))) {
      return res.status(403).json({ ok: false, message: "Only participants can start this match" });
    }
    if (!["FUNDS_HELD", "CREATED"].includes(upper(levelMatch.status))) {
      return res.status(409).json({ ok: false, message: "Only created/held matches can be started" });
    }

    levelMatch.status = "ONGOING";
    levelMatch.startedAt = new Date();
    await levelMatch.save();
    return res.json({ ok: true, message: "Level match started", match: levelMatchResponse(levelMatch) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to start level match" });
  }
}

export async function settleLevelMatch(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);

  const actorId = toId(req.userId);
  const sessionId = upper(req.params.sessionId || req.body?.sessionId);
  const winnerUserId = toId(req.body?.winnerUserId || req.body?.winnerId);
  if (!actorId) return res.status(401).json({ ok: false, message: "Unauthorized" });
  if (!sessionId || !winnerUserId || !mongoose.Types.ObjectId.isValid(winnerUserId)) {
    return res.status(400).json({ ok: false, message: "Valid sessionId and winnerUserId are required" });
  }

  const snapshot = await LevelMatchSession.findOne({ sessionId }).lean();
  if (!snapshot) return res.status(404).json({ ok: false, message: "Level match not found" });
  if (!snapshot.participants.some((p) => sameId(p, actorId))) {
    return res.status(403).json({ ok: false, message: "Only participants can settle this match" });
  }
  if (!snapshot.participants.some((p) => sameId(p, winnerUserId))) {
    return res.status(400).json({ ok: false, message: "winnerUserId must belong to this match" });
  }
  if (!["ONGOING", "FUNDS_HELD"].includes(upper(snapshot.status))) {
    return res.status(409).json({ ok: false, message: "Match is not in a settlable state" });
  }

  const loserUserId = snapshot.participants.find((p) => !sameId(p, winnerUserId));
  if (!loserUserId) return res.status(400).json({ ok: false, message: "Unable to determine loser" });

  const commissionBps = levelCommissionBps();
  const totalPotMinor = Number(snapshot.totalPotMinor || 0);
  const commissionMinor = Math.floor((totalPotMinor * commissionBps) / 10000);
  const payoutMinor = Math.max(0, totalPotMinor - commissionMinor);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const locked = await LevelMatchSession.findOne({ sessionId }).session(session);
    if (!locked) throw new Error("Level match not found");
    if (upper(locked.status) === "SETTLED") {
      await session.commitTransaction();
      session.endSession();
      return res.json({ ok: true, reused: true, match: levelMatchResponse(locked) });
    }

    const stakeMinor = Number(locked.stakeMinor || 0);
    const challengerHoldBalance = await getAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: locked.challengerHoldAccountId,
      currency: locked.currency,
      session,
    });
    const opponentHoldBalance = await getAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: locked.opponentHoldAccountId,
      currency: locked.currency,
      session,
    });
    if (challengerHoldBalance < stakeMinor || opponentHoldBalance < stakeMinor) {
      throw new Error("Level match hold balances are insufficient");
    }

    const ledgerSourceId = upper(`LM_SETTLE_${locked.sessionId}`);
    await postBalancedLedgerEntries({
      currency: locked.currency,
      sourceType: "SETTLEMENT",
      sourceId: ledgerSourceId,
      session,
      metadata: {
        operation: "LEVEL_MATCH_SETTLEMENT",
        levelSessionId: locked.sessionId,
        level: locked.level,
      },
      lines: [
        {
          direction: "DEBIT",
          accountType: "HOLD_BALANCE",
          accountId: locked.challengerHoldAccountId,
          amountMinor: stakeMinor,
        },
        {
          direction: "DEBIT",
          accountType: "HOLD_BALANCE",
          accountId: locked.opponentHoldAccountId,
          amountMinor: stakeMinor,
        },
        {
          direction: "CREDIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(winnerUserId),
          amountMinor: payoutMinor,
        },
        ...(commissionMinor > 0
          ? [
              {
                direction: "CREDIT",
                accountType: "PLATFORM_REVENUE",
                accountId: "PLATFORM_DEFAULT",
                amountMinor: commissionMinor,
              },
            ]
          : []),
      ],
    });

    await WalletHold.updateMany(
      { holdId: { $in: [locked.challengerHoldId, locked.opponentHoldId] } },
      { status: "CAPTURED", capturedAt: new Date() },
      { session }
    );

    const settlementId = upper(`LM_ST_${locked.sessionId}`);
    await Settlement.findOneAndUpdate(
      { settlementId },
      {
        settlementId,
        module: "MATCH",
        moduleRefId: locked.sessionId,
        currency: locked.currency,
        totalMinor: totalPotMinor,
        settledMinor: totalPotMinor,
        outstandingMinor: 0,
        status: "SETTLED",
        settledAt: new Date(),
        lines: [
          {
            accountType: "HOLD_BALANCE",
            accountId: locked.challengerHoldAccountId,
            debitMinor: stakeMinor,
            creditMinor: 0,
            note: "Challenger hold consumed",
          },
          {
            accountType: "HOLD_BALANCE",
            accountId: locked.opponentHoldAccountId,
            debitMinor: stakeMinor,
            creditMinor: 0,
            note: "Opponent hold consumed",
          },
          {
            accountType: "USER_WALLET",
            accountId: walletAccountId(winnerUserId),
            debitMinor: 0,
            creditMinor: payoutMinor,
            note: "Winner credited",
          },
          ...(commissionMinor > 0
            ? [
                {
                  accountType: "PLATFORM_REVENUE",
                  accountId: "PLATFORM_DEFAULT",
                  debitMinor: 0,
                  creditMinor: commissionMinor,
                  note: "Platform commission",
                },
              ]
            : []),
        ],
        metadata: { levelSessionId: locked.sessionId, ledgerSourceId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session }
    );

    const [winnerUser, loserUser] = await Promise.all([
      User.findById(winnerUserId).select("stats earnings profile").session(session),
      User.findById(loserUserId).select("stats earnings profile").session(session),
    ]);
    if (!winnerUser || !loserUser) throw new Error("Players not found");

    const winnerPrevWon = Number(winnerUser.stats?.gamesWon || 0);
    const winnerPrevLost = Number(winnerUser.stats?.gamesLost || 0);
    const winnerPrevDraw = Number(winnerUser.stats?.gamesDrawn || 0);
    const winnerPrevTotal = Number(
      winnerUser.stats?.totalMatches || winnerPrevWon + winnerPrevLost + winnerPrevDraw
    );
    const winnerPrevCurrentStreak = Number(winnerUser.stats?.currentWinStreak || 0);
    const winnerPrevBestStreak = Number(winnerUser.stats?.bestWinStreak || 0);
    const winnerNextWon = winnerPrevWon + 1;
    const winnerNextTotal = winnerPrevTotal + 1;
    const winnerNextCurrentStreak = winnerPrevCurrentStreak + 1;
    const winnerNextBestStreak = Math.max(winnerPrevBestStreak, winnerNextCurrentStreak);
    const winnerNextWinRate = winnerNextTotal > 0 ? (winnerNextWon * 100) / winnerNextTotal : 0;

    const loserPrevWon = Number(loserUser.stats?.gamesWon || 0);
    const loserPrevLost = Number(loserUser.stats?.gamesLost || 0);
    const loserPrevDraw = Number(loserUser.stats?.gamesDrawn || 0);
    const loserPrevTotal = Number(
      loserUser.stats?.totalMatches || loserPrevWon + loserPrevLost + loserPrevDraw
    );
    const loserNextLost = loserPrevLost + 1;
    const loserNextTotal = loserPrevTotal + 1;
    const loserNextWinRate = loserNextTotal > 0 ? (loserPrevWon * 100) / loserNextTotal : 0;

    const payoutMajor = toMajor(payoutMinor);
    const monthIndex = new Date().getMonth();
    const winnerYearToDate = normalizeYearToDateArray(winnerUser.earnings?.yearToDate);
    winnerYearToDate[monthIndex] = Math.max(0, asNumber(winnerYearToDate[monthIndex], 0) + payoutMajor);

    const winnerPrevTotalEarnings = asNumber(
      winnerUser.earnings?.total ??
        winnerUser.earnings?.career ??
        winnerUser.stats?.totalWinnings,
      0
    );
    const winnerNextTotalEarnings = winnerPrevTotalEarnings + payoutMajor;
    const winnerNextLevel = Math.max(resolveUserLevel(winnerUser), normalizeLevel(locked.level + 1));

    await User.findByIdAndUpdate(
      winnerUserId,
      {
        $inc: {
          "earnings.availableBalance": payoutMajor,
          "earnings.career": payoutMajor,
          "stats.totalWinnings": payoutMajor,
          "stats.gamesWon": 1,
          "stats.totalMatches": 1,
          "stats.score": WINNER_SCORE_BONUS,
        },
        $set: {
          "stats.currentWinStreak": winnerNextCurrentStreak,
          "stats.bestWinStreak": winnerNextBestStreak,
          "stats.winRate": Math.max(0, Math.min(100, winnerNextWinRate)),
          "earnings.yearToDate": winnerYearToDate,
          "earnings.total": winnerNextTotalEarnings,
          "stats.highestLevelAchieved": winnerNextLevel,
          "profile.highestLevelAchieved": winnerNextLevel,
        },
      },
      { session }
    );

    await User.findByIdAndUpdate(
      loserUserId,
      {
        $inc: {
          "stats.gamesLost": 1,
          "stats.totalMatches": 1,
          "stats.score": LOSER_SCORE_BONUS,
        },
        $set: {
          "stats.currentWinStreak": 0,
          "stats.winRate": Math.max(0, Math.min(100, loserNextWinRate)),
        },
      },
      { session }
    );

    await Transaction.create(
      [
        {
          user: winnerUserId,
          amount: payoutMajor,
          type: "payout",
          status: "completed",
          meta: { levelSessionId: locked.sessionId, level: locked.level, commissionMinor },
        },
      ],
      { session }
    );

    locked.status = "SETTLED";
    locked.winnerUserId = winnerUserId;
    locked.loserUserId = loserUserId;
    locked.payoutMinor = payoutMinor;
    locked.commissionMinor = commissionMinor;
    locked.ledgerSourceId = ledgerSourceId;
    locked.settlementId = settlementId;
    locked.endedAt = new Date();
    await locked.save({ session });

    await session.commitTransaction();
    session.endSession();

    try {
      if (commissionMinor > 0) {
        const c0 = Math.floor(commissionMinor / 2);
        const c1 = commissionMinor - c0;
        await Promise.all([
          postReferralCommission({
            referredUserId: locked.challengerUserId,
            sourceModule: "LEVEL_MATCH",
            sourceRefId: `${locked.sessionId}:CHALLENGER`,
            sourceCommissionMinor: c0,
            currency: locked.currency,
            metadata: { levelSessionId: locked.sessionId, level: locked.level },
          }),
          postReferralCommission({
            referredUserId: locked.opponentUserId,
            sourceModule: "LEVEL_MATCH",
            sourceRefId: `${locked.sessionId}:OPPONENT`,
            sourceCommissionMinor: c1,
            currency: locked.currency,
            metadata: { levelSessionId: locked.sessionId, level: locked.level },
          }),
        ]);
      }
    } catch (refErr) {
      console.error("Referral posting failed for level settlement:", refErr?.message || refErr);
    }

    try {
      await Promise.all([
        evaluateAndAwardMilestones({
          userId: winnerUserId,
          trigger: "LEVEL_MATCH_SETTLED",
          sourceModule: "LEVEL_MATCH",
          sourceRefId: locked.sessionId,
        }),
        evaluateAndAwardMilestones({
          userId: loserUserId,
          trigger: "LEVEL_MATCH_SETTLED",
          sourceModule: "LEVEL_MATCH",
          sourceRefId: locked.sessionId,
        }),
      ]);
    } catch (awardErr) {
      console.error("Achievement evaluation failed for level settlement:", awardErr?.message || awardErr);
    }

    return res.json({
      ok: true,
      message: "Level match settled successfully",
      match: levelMatchResponse(locked),
      levelProgression: { winnerUserId: toId(winnerUserId), loserUserId: toId(loserUserId), winnerNextLevel },
    });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ ok: false, message: e.message || "Failed to settle level match" });
  }
}

export async function cancelLevelMatch(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);

  const actorId = toId(req.userId);
  const sessionId = upper(req.params.sessionId || req.body?.sessionId);
  const reason = cleanString(req.body?.reason || "Cancelled by participant");
  if (!actorId) return res.status(401).json({ ok: false, message: "Unauthorized" });
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId is required" });

  const snapshot = await LevelMatchSession.findOne({ sessionId }).lean();
  if (!snapshot) return res.status(404).json({ ok: false, message: "Level match not found" });
  if (!snapshot.participants.some((p) => sameId(p, actorId))) {
    return res.status(403).json({ ok: false, message: "Only participants can cancel this match" });
  }
  if (upper(snapshot.status) === "SETTLED") {
    return res.status(409).json({ ok: false, message: "Settled matches cannot be cancelled" });
  }
  if (upper(snapshot.status) === "CANCELLED") {
    return res.json({ ok: true, reused: true, match: levelMatchResponse(snapshot) });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const locked = await LevelMatchSession.findOne({ sessionId }).session(session);
    if (!locked) throw new Error("Level match not found");

    const stakeMinor = Number(locked.stakeMinor || 0);
    const chBalance = await getAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: locked.challengerHoldAccountId,
      currency: locked.currency,
      session,
    });
    const opBalance = await getAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: locked.opponentHoldAccountId,
      currency: locked.currency,
      session,
    });

    const chRefundMinor = Math.max(0, Math.min(chBalance, stakeMinor));
    const opRefundMinor = Math.max(0, Math.min(opBalance, stakeMinor));
    const lines = [];
    if (chRefundMinor > 0) {
      lines.push(
        {
          direction: "DEBIT",
          accountType: "HOLD_BALANCE",
          accountId: locked.challengerHoldAccountId,
          amountMinor: chRefundMinor,
        },
        {
          direction: "CREDIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(locked.challengerUserId),
          amountMinor: chRefundMinor,
        }
      );
    }
    if (opRefundMinor > 0) {
      lines.push(
        {
          direction: "DEBIT",
          accountType: "HOLD_BALANCE",
          accountId: locked.opponentHoldAccountId,
          amountMinor: opRefundMinor,
        },
        {
          direction: "CREDIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(locked.opponentUserId),
          amountMinor: opRefundMinor,
        }
      );
    }
    if (lines.length > 0) {
      await postBalancedLedgerEntries({
        currency: locked.currency,
        sourceType: "WITHDRAWAL",
        sourceId: upper(`LM_CANCEL_${locked.sessionId}`),
        session,
        metadata: { operation: "LEVEL_MATCH_CANCEL_RELEASE", levelSessionId: locked.sessionId },
        lines,
      });
    }

    await WalletHold.updateMany(
      { holdId: { $in: [locked.challengerHoldId, locked.opponentHoldId] } },
      { status: "RELEASED", releasedAt: new Date() },
      { session }
    );

    const chRefundMajor = toMajor(chRefundMinor);
    const opRefundMajor = toMajor(opRefundMinor);
    if (chRefundMajor > 0) {
      await User.findByIdAndUpdate(
        locked.challengerUserId,
        { $inc: { "earnings.availableBalance": chRefundMajor } },
        { session }
      );
    }
    if (opRefundMajor > 0) {
      await User.findByIdAndUpdate(
        locked.opponentUserId,
        { $inc: { "earnings.availableBalance": opRefundMajor } },
        { session }
      );
    }

    const txRows = [];
    if (chRefundMajor > 0) {
      txRows.push({
        user: locked.challengerUserId,
        amount: chRefundMajor,
        type: "refund",
        status: "completed",
        meta: { levelSessionId: locked.sessionId, reason },
      });
    }
    if (opRefundMajor > 0) {
      txRows.push({
        user: locked.opponentUserId,
        amount: opRefundMajor,
        type: "refund",
        status: "completed",
        meta: { levelSessionId: locked.sessionId, reason },
      });
    }
    if (txRows.length > 0) {
      await Transaction.create(txRows, { session });
    }

    locked.status = "CANCELLED";
    locked.cancelReason = reason;
    locked.cancelledAt = new Date();
    await locked.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({
      ok: true,
      message: "Level match cancelled and stakes released",
      match: levelMatchResponse(locked),
    });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ ok: false, message: e.message || "Failed to cancel level match" });
  }
}

export async function myLevelMatches(req, res) {
  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const status = upper(req.query.status || "");
    const filter = {
      participants: { $in: [new mongoose.Types.ObjectId(userId)] },
    };
    if (status) {
      const list = status
        .split(",")
        .map((x) => upper(x))
        .filter(Boolean);
      if (list.length > 0) filter.status = { $in: list };
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const matches = await LevelMatchSession.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      matches: matches.map(levelMatchResponse),
      meta: {
        count: matches.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load level matches" });
  }
}

export async function myMatchmakingStatus(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);
  if (!matchmakingEnabled()) return matchmakingUnavailable(res);

  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const user = await User.findById(userId)
      .select(
        [
          "username",
          "profile.nickname",
          "profile.minLevel",
          "profile.maxLevel",
          "profile.highestLevelAchieved",
          "stats.highestLevelAchieved",
          "location",
          "profile.latitude",
          "profile.longitude",
        ].join(" ")
      )
      .lean();
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const state = await LevelMatchmakingState.findOne({ userId }).lean();
    const activeLevelSession = await hasActiveLevelSessionForUser(userId);
    const fallbackLevel = resolveUserLevel(user);
    const range = normalizePreferredRange({
      minLevel: state?.minLevel ?? user?.profile?.minLevel,
      maxLevel: state?.maxLevel ?? user?.profile?.maxLevel,
      preferredLevel: state?.preferredLevel,
      fallbackLevel,
    });

    return res.json({
      ok: true,
      matchmaking: availabilityResponse(
        state || {
          live: false,
          status: "PAUSED",
          preferredLevel: range.preferredLevel,
          minLevel: range.minLevel,
          maxLevel: range.maxLevel,
          radiusKm: matchmakingDefaultRadiusKm(),
          autoAccept: false,
          geo: user?.location,
        },
        user,
        { activeLevelSession }
      ),
      featureEnabled: true,
      serverTimeMs: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load matchmaking status",
    });
  }
}

export async function updateMatchmakingStatus(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);
  if (!matchmakingEnabled()) return matchmakingUnavailable(res);

  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const user = await User.findById(userId)
      .select(
        [
          "username",
          "profile.nickname",
          "profile.minLevel",
          "profile.maxLevel",
          "profile.highestLevelAchieved",
          "stats.highestLevelAchieved",
          "location",
          "profile.latitude",
          "profile.longitude",
        ].join(" ")
      )
      .lean();
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const existing = await LevelMatchmakingState.findOne({ userId }).lean();
    const fallbackLevel = resolveUserLevel(user);
    const nextLive = req.body?.live === undefined ? !!existing?.live : !!req.body?.live;
    const nextRadiusKm = parseRadiusKm(
      req.body?.radiusKm,
      parseRadiusKm(existing?.radiusKm, matchmakingDefaultRadiusKm())
    );
    const range = normalizePreferredRange({
      minLevel: req.body?.minLevel ?? existing?.minLevel ?? user?.profile?.minLevel,
      maxLevel: req.body?.maxLevel ?? existing?.maxLevel ?? user?.profile?.maxLevel,
      preferredLevel: req.body?.preferredLevel ?? existing?.preferredLevel,
      fallbackLevel,
    });

    const incomingGeo = parseCoordinateInput(req.body?.location || {});
    let sourceGeo = incomingGeo || getCoordinatePair(existing?.geo || {}) || getUserCoordinatePair(user || {});

    if (incomingGeo) {
      await User.findByIdAndUpdate(userId, {
        location: { type: "Point", coordinates: [incomingGeo.lng, incomingGeo.lat] },
        "profile.latitude": incomingGeo.lat,
        "profile.longitude": incomingGeo.lng,
      });
      sourceGeo = incomingGeo;
    }

    const now = new Date();
    const state = await LevelMatchmakingState.findOneAndUpdate(
      { userId },
      {
        userId,
        live: nextLive,
        status: nextLive ? "LIVE" : "PAUSED",
        minLevel: range.minLevel,
        maxLevel: range.maxLevel,
        preferredLevel: range.preferredLevel,
        radiusKm: nextRadiusKm,
        autoAccept: req.body?.autoAccept === undefined ? !!existing?.autoAccept : !!req.body?.autoAccept,
        lastHeartbeatAt: now,
        ...(sourceGeo
          ? {
              geo: {
                type: "Point",
                coordinates: [sourceGeo.lng, sourceGeo.lat],
              },
            }
          : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const refreshedUser = incomingGeo
      ? await User.findById(userId)
          .select("username profile.nickname location profile.latitude profile.longitude")
          .lean()
      : user;

    return res.json({
      ok: true,
      message: nextLive ? "You are now live for level matchmaking." : "Matchmaking paused.",
      matchmaking: availabilityResponse(state, refreshedUser),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to update matchmaking status" });
  }
}

export async function levelMatchmakingCandidates(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);
  if (!matchmakingEnabled()) return matchmakingUnavailable(res);

  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const actorUser = await User.findById(userId)
      .select(
        [
          "username",
          "profile.nickname",
          "profile.minLevel",
          "profile.maxLevel",
          "profile.highestLevelAchieved",
          "stats.highestLevelAchieved",
          "location",
          "profile.latitude",
          "profile.longitude",
          "earnings.availableBalance",
        ].join(" ")
      )
      .lean();
    if (!actorUser) return res.status(404).json({ ok: false, message: "User not found" });

    const hasActive = await hasActiveLevelSessionForUser(userId);
    if (hasActive) {
      return res.status(409).json({
        ok: false,
        code: "ACTIVE_LEVEL_MATCH_EXISTS",
        message: "You already have an active level match.",
      });
    }

    const actorState = await LevelMatchmakingState.findOne({ userId }).lean();
    const targetLevel = normalizeLevel(req.query?.level || req.body?.level || actorState?.preferredLevel || resolveUserLevel(actorUser));
    const limit = Math.max(1, Math.min(30, Number(req.query?.limit || req.body?.limit || 10)));
    const result = await collectMatchmakingCandidates({
      actorUser,
      actorState,
      targetLevel,
      requestedRadiusKm: req.query?.radiusKm || req.body?.radiusKm,
      limit,
    });

    if (result.blocked) {
      return res.status(400).json({
        ok: false,
        code: result.code,
        message: result.message,
        requiredStakeMinor: result.requiredStakeMinor,
        walletBalanceMinor: result.actorWalletMinor,
      });
    }

    return res.json({
      ok: true,
      candidates: result.candidates,
      meta: {
        targetLevel,
        radiusKm: result.radiusKm,
        requiredStakeMinor: result.requiredStakeMinor,
        walletBalanceMinor: result.actorWalletMinor,
        count: result.candidates.length,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to fetch matchmaking candidates" });
  }
}

export async function autoCreateLevelChallenge(req, res) {
  if (!levelEconomyEnabled()) return serviceUnavailable(res);
  if (!matchmakingEnabled()) return matchmakingUnavailable(res);

  try {
    const userId = toId(req.userId);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const actorState = await LevelMatchmakingState.findOne({ userId }).lean();
    if (!actorState?.live) {
      return res.status(400).json({
        ok: false,
        code: "MATCHMAKING_NOT_LIVE",
        message: "Turn on Live matchmaking first, then try auto-match.",
      });
    }

    const actorUser = await User.findById(userId)
      .select(
        [
          "username",
          "profile.nickname",
          "profile.highestLevelAchieved",
          "stats.highestLevelAchieved",
          "location",
          "profile.latitude",
          "profile.longitude",
          "earnings.availableBalance",
        ].join(" ")
      )
      .lean();
    if (!actorUser) return res.status(404).json({ ok: false, message: "User not found" });

    const targetLevel = normalizeLevel(req.body?.level || actorState?.preferredLevel || resolveUserLevel(actorUser));
    const result = await collectMatchmakingCandidates({
      actorUser,
      actorState,
      targetLevel,
      requestedRadiusKm: req.body?.radiusKm,
      limit: 10,
    });

    if (result.blocked) {
      return res.status(400).json({
        ok: false,
        code: result.code,
        message: result.message,
        requiredStakeMinor: result.requiredStakeMinor,
        walletBalanceMinor: result.actorWalletMinor,
      });
    }

    let selected = null;
    const requestedOpponentId = toId(req.body?.opponentUserId);
    if (requestedOpponentId) {
      selected = result.candidates.find((row) => sameId(row.userId, requestedOpponentId)) || null;
      if (!selected) {
        return res.status(404).json({
          ok: false,
          code: "REQUESTED_OPPONENT_NOT_ELIGIBLE",
          message: "Requested opponent is not currently eligible for this level match.",
        });
      }
    } else {
      selected = result.candidates[0] || null;
    }

    if (!selected) {
      return res.status(404).json({
        ok: false,
        code: "NO_MATCH_FOUND",
        message: "No live players found right now. Please try again shortly.",
      });
    }

    req.body = {
      ...(req.body || {}),
      level: targetLevel,
      opponentUserId: selected.userId,
    };

    await LevelMatchmakingState.findOneAndUpdate(
      { userId },
      { lastHeartbeatAt: new Date() },
      { new: false }
    );

    return createLevelChallenge(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to auto-create level challenge" });
  }
}
