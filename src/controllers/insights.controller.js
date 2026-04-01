import mongoose from "mongoose";
import User from "../models/user.model.js";
import PrizeAward from "../models/prizeAward.model.js";
import Tournament from "../models/tournament.model.js";
import TournamentEntryOrder from "../models/tournamentEntryOrder.model.js";
import DisputeCase from "../models/disputeCase.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import { evaluateAndAwardMilestones } from "../services/achievement.service.js";

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

function insightsEnabled() {
  return boolFromEnv("FEATURE_INSIGHTS_V2", false);
}

function requestUserId(req) {
  return cleanString(req.user?.id || req.user?._id || req.userId);
}

function requestClubId(req) {
  return cleanString(req.clubId || req.club?._id);
}

function asNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asInt(v, fallback = 0) {
  return Math.round(asNum(v, fallback));
}

function normalizeCategory(raw) {
  const k = cleanString(raw).toLowerCase();
  if (k === "youth") return "youth";
  if (["ladies", "women", "female"].includes(k)) return "ladies";
  if (["men", "male", "boys"].includes(k)) return "men";
  if (["seniors", "senior"].includes(k)) return "seniors";
  if (["masters", "master"].includes(k)) return "masters";
  return "global";
}

function normalizeScope(raw) {
  const k = cleanString(raw).toLowerCase();
  if (k === "country") return "country";
  if (["region", "state", "county"].includes(k)) return "region";
  return "global";
}

function ageFromDob(dobLike) {
  if (!dobLike) return -1;
  const dt = new Date(dobLike);
  if (Number.isNaN(dt.getTime())) return -1;
  const now = new Date();
  let age = now.getFullYear() - dt.getFullYear();
  const m = now.getMonth() - dt.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dt.getDate())) age -= 1;
  return age >= 0 ? age : -1;
}

function normalizeMetric(raw) {
  const k = cleanString(raw).toLowerCase();
  if (["winnings", "totalwinnings", "earnings"].includes(k)) return "winnings";
  if (["winrate", "win_rate"].includes(k)) return "winRate";
  if (["wins", "gameswon"].includes(k)) return "wins";
  if (["streak", "winstreak"].includes(k)) return "streak";
  return "score";
}

function resolveCountry(u = {}) {
  const p = u.profile || {};
  return cleanString(p.country || p.countryCode || p.countryName);
}

function resolveRegion(u = {}) {
  const p = u.profile || {};
  return cleanString(p.region || p.state || p.county || p.province);
}

function includeByCategory(u = {}, category = "global") {
  if (category === "global") return true;
  const p = u.profile || {};
  const age = ageFromDob(p.dateOfBirth);
  if (category === "youth") return age >= 0 && age < 18;
  if (category === "seniors") return age >= 40;
  if (category === "masters") return age >= 50;
  const g = cleanString(p.gender).toLowerCase();
  if (category === "ladies") return ["f", "female", "woman", "women", "lady", "girl"].includes(g);
  if (category === "men") return ["m", "male", "man", "men", "boy"].includes(g);
  return true;
}

function includeByScope(u = {}, scope = "global", viewerCountry = "", viewerRegion = "") {
  if (scope === "global") return true;
  const rowCountry = resolveCountry(u).toLowerCase();
  const rowRegion = resolveRegion(u).toLowerCase();
  const vc = cleanString(viewerCountry).toLowerCase();
  const vr = cleanString(viewerRegion).toLowerCase();
  if (scope === "country") {
    if (!vc) return true;
    return !!rowCountry && rowCountry === vc;
  }
  if (vc && rowCountry && rowCountry !== vc) return false;
  if (!vr) return true;
  return !!rowRegion && rowRegion === vr;
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "INSIGHTS_DISABLED",
    message: "Insights module is currently disabled.",
  });
}

function prizeResponse(row) {
  return {
    awardId: cleanString(row?.awardId),
    code: upper(row?.code),
    title: cleanString(row?.title),
    description: cleanString(row?.description),
    kind: upper(row?.kind || "CUP"),
    trigger: upper(row?.trigger || "SYSTEM"),
    sourceModule: upper(row?.sourceModule || "OTHER"),
    sourceRefId: cleanString(row?.sourceRefId),
    awardedAt: row?.awardedAt || null,
    createdAt: row?.createdAt || null,
  };
}

async function organizerLedgerBalanceMinor({ accountType, accountId, currency = "GBP" }) {
  const rows = await LedgerEntry.aggregate([
    {
      $match: {
        accountType: upper(accountType),
        accountId: cleanString(accountId),
        currency: upper(currency, "GBP"),
        status: "POSTED",
      },
    },
    {
      $group: {
        _id: null,
        debitMinor: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
        creditMinor: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
      },
    },
  ]);
  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

export async function myAwards(req, res) {
  if (!insightsEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const rows = await PrizeAward.find({ userId }).sort({ awardedAt: -1 }).limit(limit).lean();

    return res.json({
      ok: true,
      awards: rows.map(prizeResponse),
      meta: { count: rows.length, limit, serverTimeMs: Date.now() },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load awards" });
  }
}

export async function evaluateMyAwards(req, res) {
  if (!insightsEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const result = await evaluateAndAwardMilestones({
      userId,
      trigger: upper(req.body?.trigger || "MANUAL"),
      sourceModule: upper(req.body?.sourceModule || "OTHER"),
      sourceRefId: cleanString(req.body?.sourceRefId),
    });

    const rows = await PrizeAward.find({ userId }).sort({ awardedAt: -1 }).limit(20).lean();
    return res.json({
      ok: true,
      result,
      recentAwards: rows.map(prizeResponse),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to evaluate awards" });
  }
}

export async function advancedLeaderboard(req, res) {
  if (!insightsEnabled()) return serviceUnavailable(res);
  try {
    const category = normalizeCategory(req.query.category || req.query.filter);
    const scope = normalizeScope(req.query.scope || req.query.geoScope);
    const metric = normalizeMetric(req.query.metric || "score");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const skip = (page - 1) * limit;

    const viewerCountry = cleanString(
      req.query.country ||
        req.query.countryCode ||
        req.user?.profile?.country ||
        req.user?.profile?.countryCode ||
        req.user?.profile?.countryName
    );
    const viewerRegion = cleanString(
      req.query.region ||
        req.query.state ||
        req.query.county ||
        req.user?.profile?.region ||
        req.user?.profile?.state ||
        req.user?.profile?.county
    );

    const users = await User.find({})
      .select(
        [
          "_id",
          "username",
          "profile.nickname",
          "profile.gender",
          "profile.dateOfBirth",
          "profile.country",
          "profile.countryCode",
          "profile.countryName",
          "profile.region",
          "profile.state",
          "profile.county",
          "profile.province",
          "stats.score",
          "stats.totalWinnings",
          "stats.gamesWon",
          "stats.gamesLost",
          "stats.gamesDrawn",
          "stats.totalMatches",
          "stats.winRate",
          "stats.bestWinStreak",
          "stats.rank",
          "stats.userIdTag",
        ].join(" ")
      )
      .lean();

    const filtered = users
      .filter((u) => includeByCategory(u, category))
      .filter((u) => includeByScope(u, scope, viewerCountry, viewerRegion));

    const normalized = filtered.map((u) => {
      const wins = asInt(u?.stats?.gamesWon, 0);
      const losses = asInt(u?.stats?.gamesLost, 0);
      const draws = asInt(u?.stats?.gamesDrawn, 0);
      const totalMatches = Math.max(asInt(u?.stats?.totalMatches, wins + losses + draws), wins + losses + draws);
      const winRate = totalMatches > 0 ? (wins * 100) / totalMatches : 0;
      return {
        userId: cleanString(u?._id),
        username: cleanString(u?.username),
        nickname: cleanString(u?.profile?.nickname),
        rank: cleanString(u?.stats?.rank),
        userIdTag: cleanString(u?.stats?.userIdTag),
        score: asInt(u?.stats?.score, 0),
        winnings: asNum(u?.stats?.totalWinnings, 0),
        wins,
        totalMatches,
        winRate: Number((asNum(u?.stats?.winRate, winRate)).toFixed(2)),
        streak: asInt(u?.stats?.bestWinStreak, 0),
      };
    });

    const metricKey = metric;
    normalized.sort((a, b) => {
      const av = asNum(a?.[metricKey], 0);
      const bv = asNum(b?.[metricKey], 0);
      if (bv !== av) return bv - av;
      if (b.score !== a.score) return b.score - a.score;
      return String(a.nickname || a.username || "Player").localeCompare(
        String(b.nickname || b.username || "Player")
      );
    });

    const total = normalized.length;
    const paged = normalized.slice(skip, skip + limit).map((row, idx) => ({
      rankPosition: skip + idx + 1,
      ...row,
    }));

    return res.json({
      ok: true,
      leaderboard: paged,
      meta: {
        category,
        scope,
        metric,
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load advanced leaderboard" });
  }
}

export async function organizerDashboard(req, res) {
  if (!insightsEnabled()) return serviceUnavailable(res);
  try {
    const clubId = requestClubId(req);
    if (!clubId) return res.status(401).json({ ok: false, message: "Unauthorized organizer" });

    const [tournamentsAgg, ordersAgg, disputesAgg, organizerBalanceMinor] = await Promise.all([
      Tournament.aggregate([
        { $match: { clubId: new mongoose.Types.ObjectId(clubId) } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            draft: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            active: { $sum: { $cond: [{ $in: ["$status", ["ACTIVE", "LIVE"]] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
          },
        },
      ]),
      TournamentEntryOrder.aggregate([
        { $match: { clubId: new mongoose.Types.ObjectId(clubId) } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            paidOrders: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, 1, 0] } },
            pendingOrders: { $sum: { $cond: [{ $eq: ["$status", "PENDING_PAYMENT"] }, 1, 0] } },
            grossMinor: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$amountMinor", 0] } },
            organizerShareMinor: {
              $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$organizerShareMinor", 0] },
            },
            prizePoolMinor: {
              $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$prizePoolMinor", 0] },
            },
          },
        },
      ]),
      DisputeCase.aggregate([
        { $match: { organizerClubId: new mongoose.Types.ObjectId(clubId) } },
        {
          $group: {
            _id: null,
            totalCases: { $sum: 1 },
            openCases: {
              $sum: { $cond: [{ $in: ["$status", ["OPEN", "IN_REVIEW", "ESCALATED"]] }, 1, 0] },
            },
            resolvedCases: { $sum: { $cond: [{ $eq: ["$status", "RESOLVED"] }, 1, 0] } },
          },
        },
      ]),
      organizerLedgerBalanceMinor({
        accountType: "ORGANIZER_BALANCE",
        accountId: clubId,
        currency: "GBP",
      }),
    ]);

    const tournaments = tournamentsAgg[0] || { total: 0, draft: 0, active: 0, completed: 0 };
    const orders = ordersAgg[0] || {
      totalOrders: 0,
      paidOrders: 0,
      pendingOrders: 0,
      grossMinor: 0,
      organizerShareMinor: 0,
      prizePoolMinor: 0,
    };
    const disputes = disputesAgg[0] || { totalCases: 0, openCases: 0, resolvedCases: 0 };

    const alertCount = asInt(orders.pendingOrders, 0) + asInt(disputes.openCases, 0);
    return res.json({
      ok: true,
      dashboard: {
        tournaments,
        orders,
        disputes,
        balances: {
          currency: "GBP",
          organizerBalanceMinor,
        },
        alerts: {
          count: alertCount,
          hasPendingOrders: asInt(orders.pendingOrders, 0) > 0,
          hasOpenDisputes: asInt(disputes.openCases, 0) > 0,
        },
      },
      serverTimeMs: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load organizer dashboard" });
  }
}

export async function deepHealth(req, res) {
  try {
    const readyState = Number(mongoose.connection?.readyState || 0);
    const dbState = readyState === 1 ? "CONNECTED" : readyState === 2 ? "CONNECTING" : "DISCONNECTED";
    const memory = process.memoryUsage();

    const payload = {
      ok: dbState === "CONNECTED",
      uptimeSec: Math.floor(process.uptime()),
      dbState,
      mongoReadyState: readyState,
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      features: {
        insightsV2: insightsEnabled(),
        achievementsV2: boolFromEnv("FEATURE_ACHIEVEMENTS_V2", false),
        referralsV2: boolFromEnv("FEATURE_REFERRAL_V2", false),
        disputesV2: boolFromEnv("FEATURE_DISPUTE_V2", false),
        paymentsV2: boolFromEnv("FEATURE_PAYMENTS_V2", false),
      },
      now: new Date().toISOString(),
    };

    return res.status(payload.ok ? 200 : 503).json(payload);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load deep health",
    });
  }
}
