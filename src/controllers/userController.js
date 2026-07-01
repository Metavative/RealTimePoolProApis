// src/controllers/userController.js
import User from "../models/user.model.js";
import Club from "../models/club.model.js";
import FriendRequest from "../models/friendRequest.model.js";
import Friendship from "../models/friendship.model.js";
import Match from "../models/match.model.js";
import LevelMatchSession from "../models/levelMatchSession.model.js";
import LevelMatchmakingState from "../models/levelMatchmakingState.model.js";
import StoreOrder from "../models/storeOrder.model.js";
import PaymentIntent from "../models/paymentIntent.model.js";
import WalletHold from "../models/walletHold.model.js";
import Payout from "../models/payout.model.js";
import TournamentEntryOrder from "../models/tournamentEntryOrder.model.js";
import TournamentInvite from "../models/tournamentInvite.model.js";
import Tournament from "../models/tournament.model.js";
import DisputeCase from "../models/disputeCase.model.js";
import ReferralCommission from "../models/referralCommission.model.js";
import PrizeAward from "../models/prizeAward.model.js";
import UserEntitlement from "../models/userEntitlement.model.js";
import UserLoadout from "../models/userLoadout.model.js";
import Transaction from "../models/transaction.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import { v2 as cloudinary } from "cloudinary";
import { isCloudinaryConfigured } from "../config/cloudinary.config.js";

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "support",
  "help",
  "system",
  "moderator",
  "mod",
  "player",
  "null",
  "undefined",
  "root",
]);

function buildCapabilities(req) {
  return {
    canPlay: !!req?.auth?.canPlay || !!req?.userId,
    canManageVenue: !!req?.auth?.canManageVenue || !!req?.clubId,
    actorType: req?.auth?.actorType || "user",
    authType: req?.authType || "user",
  };
}

function safeClub(club) {
  if (!club) return null;
  const obj = club.toObject ? club.toObject() : { ...club };
  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;
  return obj;
}

function mergePlainObject(target = {}, patch = {}) {
  const out = { ...(target || {}) };

  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObject(out[key], value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isAvatarUrlLike(v) {
  const s = toStr(v);
  if (!s) return false;
  if (/^file:\/\//i.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
  if (s.startsWith('/storage/') || s.startsWith('/data/')) return false;
  if (s.startsWith("assets/")) return true;
  if (s.startsWith("//")) return true;
  if (s.startsWith("www.")) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return true;
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("/") ||
    s.startsWith("uploads/") ||
    s.startsWith("data:image/")
  );
}

function resolveAvatarUrl(source = {}) {
  const pickFromUnknown = (candidate) => {
    if (candidate === null || candidate === undefined) return "";
    if (typeof candidate === "string") return toStr(candidate);
    if (Array.isArray(candidate)) {
      for (const inner of candidate) {
        const picked = pickFromUnknown(inner);
        if (picked) return picked;
      }
      return "";
    }
    if (typeof candidate === "object") {
      const keys = [
        "url",
        "secure_url",
        "src",
        "avatar",
        "avatarUrl",
        "profileImage",
        "profilePic",
        "photo",
        "photoUrl",
        "image",
        "imageUrl",
        "userAvatar",
        "avatarPath",
        "path",
        "file",
        "value",
      ];
      for (const key of keys) {
        const picked = pickFromUnknown(candidate[key]);
        if (picked) return picked;
      }
    }
    return toStr(candidate);
  };

  const profile = source?.profile && typeof source.profile === "object"
    ? source.profile
    : source;

  const candidates = [
    profile?.avatarUrl,
    profile?.photo,
    profile?.profileImage,
    profile?.profilePic,
    profile?.avatar,
    profile?.photoUrl,
    profile?.imageUrl,
    profile?.image,
    profile?.userAvatar,
    profile?.avatarPath,
    source?.avatarUrl,
    source?.photo,
    source?.profileImage,
    source?.profilePic,
    source?.avatar,
    source?.photoUrl,
    source?.imageUrl,
    source?.image,
    source?.userAvatar,
    source?.avatarPath,
  ];

  for (const candidate of candidates) {
    const value = pickFromUnknown(candidate);
    if (!value || !isAvatarUrlLike(value)) continue;
    if (value.startsWith("//")) return `https:${value}`;
    if (value.startsWith("www.")) return `https://${value}`;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
    return value;
  }
  return "";
}

function normalizeAvatarProfile(profileLike = {}, { stampNow = false } = {}) {
  const profile = { ...(profileLike || {}) };
  const avatarUrl = resolveAvatarUrl(profile);

  if (avatarUrl) {
    profile.avatar = avatarUrl;
    profile.avatarUrl = avatarUrl;
    profile.photo = avatarUrl;
    profile.profileImage = avatarUrl;
    if (stampNow || !profile.avatarUpdatedAt) {
      profile.avatarUpdatedAt = new Date();
    }
  } else {
    profile.avatarUrl = "";
    if (isAvatarUrlLike(profile.photo)) profile.photo = "";
    if (isAvatarUrlLike(profile.profileImage)) profile.profileImage = "";
  }

  return profile;
}

function looksLikeEmail(v) {
  const s = toStr(v);
  return !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function looksLikePhone(v) {
  const s = toStr(v);
  if (!s) return false;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  return /^[+0-9()\-\s.]+$/.test(s);
}

function looksLikePlaceholderName(v) {
  const s = toStr(v).toLowerCase();
  if (!s) return false;
  if (/^error\d*$/.test(s)) return true;
  return ["unknown", "undefined", "null", "n/a", "na"].includes(s);
}

function cleanPublicName(v) {
  const s = toStr(v);
  if (!s) return "";
  if (looksLikeEmail(s) || looksLikePhone(s) || looksLikePlaceholderName(s)) return "";
  return s;
}

function normalizeName(v) {
  const s = toStr(v);
  return s ? s.replace(/\s+/g, " ").trim() : "";
}

function splitName(name) {
  const cleaned = normalizeName(name);
  if (!cleaned) return { firstName: "", lastName: "" };

  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function normalizeUsername(raw) {
  const username = toStr(raw);
  const lower = username.toLowerCase();
  return { username, lower };
}

function norm(v) {
  return String(v ?? "").trim().toLowerCase();
}

function validateUsername(username) {
  if (!username) return "Username is required";
  if (!USERNAME_REGEX.test(username)) {
    return "Invalid username. Use 3-20 characters: letters, numbers, underscore.";
  }
  if (/^error\d*$/i.test(username)) {
    return "This username is reserved. Please choose another.";
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return "This username is reserved. Please choose another.";
  }
  return "";
}

const ACHIEVEMENT_DEFINITIONS = Object.freeze([
  {
    id: "first_match",
    title: "First Break",
    description: "Complete your first match.",
    target: 1,
    metricKey: "matches",
  },
  {
    id: "regular_player",
    title: "Table Regular",
    description: "Play 25 total matches.",
    target: 25,
    metricKey: "matches",
  },
  {
    id: "win_starter",
    title: "Win Starter",
    description: "Win 10 matches.",
    target: 10,
    metricKey: "wins",
  },
  {
    id: "win_master",
    title: "Win Master",
    description: "Win 50 matches.",
    target: 50,
    metricKey: "wins",
  },
  {
    id: "hot_streak",
    title: "Hot Streak",
    description: "Reach a 5-win streak.",
    target: 5,
    metricKey: "streak",
  },
  {
    id: "score_riser",
    title: "Score Riser",
    description: "Reach 500 score.",
    target: 500,
    metricKey: "score",
  },
  {
    id: "score_elite",
    title: "Score Elite",
    description: "Reach 1500 score.",
    target: 1500,
    metricKey: "score",
  },
  {
    id: "earner_starter",
    title: "Earnings Starter",
    description: "Earn 500 total winnings.",
    target: 500,
    metricKey: "earnings",
  },
  {
    id: "earner_pro",
    title: "Earnings Pro",
    description: "Earn 2500 total winnings.",
    target: 2500,
    metricKey: "earnings",
  },
  {
    id: "reliable_player",
    title: "Reliable Player",
    description: "Maintain 80% match acceptance.",
    target: 80,
    metricKey: "acceptance",
  },
  {
    id: "fair_play",
    title: "Fair Play",
    description: "Maintain 90% fair play score.",
    target: 90,
    metricKey: "fair_play",
  },
]);

function asInt(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function asNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampPercent(v) {
  const n = asNum(v, 0);
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function round1(v) {
  const n = asNum(v, 0);
  return Math.round(n * 10) / 10;
}

function deriveHighestLevel(profile = {}, stats = {}) {
  const direct = asInt(
    stats?.highestLevelAchieved ??
      profile?.highestLevelAchieved ??
      profile?.highestLevelAchieve,
    -1
  );
  if (direct >= 0) return direct;

  const rank = toStr(stats?.rank).toLowerCase();
  const rankScoreMap = {
    beginner: 5,
    intermediate: 12,
    advanced: 20,
    pro: 30,
    elite: 40,
  };
  const rankScore = rankScoreMap[rank] ?? 0;

  const score = asInt(stats?.score, 0);
  const wins = asInt(stats?.gamesWon, 0);
  const fromScore = Math.floor(score / 120);
  const fromWins = Math.floor(wins / 4);

  return Math.max(1, rankScore, fromScore, fromWins);
}

function buildAchievements(metrics = {}) {
  return ACHIEVEMENT_DEFINITIONS.map((def) => {
    const progress = asInt(metrics?.[def.metricKey], 0);
    const target = asInt(def.target, 0);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      target,
      progress,
      unlocked: progress >= target,
    };
  });
}

function normalizeUserForClient(userLike) {
  if (!userLike || typeof userLike !== "object") return userLike;

  const raw = userLike.toObject ? userLike.toObject() : { ...userLike };
  const profile = { ...(raw.profile || {}) };
  const stats = { ...(raw.stats || {}) };

  const gamesWon = asInt(stats.gamesWon, 0);
  const gamesLost = asInt(stats.gamesLost, 0);
  const gamesDrawn = asInt(stats.gamesDrawn, 0);
  const totalMatches = Math.max(
    asInt(stats.totalMatches, gamesWon + gamesLost + gamesDrawn),
    gamesWon + gamesLost + gamesDrawn
  );

  const totalWinnings = asNum(stats.totalWinnings, 0);
  const bestWinStreak = asInt(stats.bestWinStreak ?? stats.winStreak, 0);
  const score = asInt(stats.score, 0);
  const disputes = asInt(stats.disputeHistoryCount, 0);
  const disputesWon = asInt(stats.disputesWon ?? stats.disputeWins, 0);

  const acceptedChallenges = asInt(
    stats.acceptedChallenges ?? stats.matchesAccepted,
    0
  );
  const declinedChallenges = asInt(
    stats.declinedChallenges ?? stats.matchesRefused,
    0
  );

  const winPercentage = totalMatches > 0
    ? clampPercent((gamesWon * 100) / totalMatches)
    : 0;

  const disputePercentage = totalMatches > 0
    ? clampPercent((disputes * 100) / totalMatches)
    : 0;

  const disputeWinPercentage = disputes > 0
    ? clampPercent((disputesWon * 100) / disputes)
    : 0;

  const totalChallenges = acceptedChallenges + declinedChallenges;
  const matchAcceptancePercentage = totalChallenges > 0
    ? clampPercent((acceptedChallenges * 100) / totalChallenges)
    : 0;
  const refusalPercentage = totalChallenges > 0
    ? clampPercent((declinedChallenges * 100) / totalChallenges)
    : 0;

  const fairPlayRaw = asNum(profile.fairPlay, 0);
  const fairPlayPercent = totalMatches > 0
    ? (fairPlayRaw <= 5
      ? clampPercent(fairPlayRaw * 20)
      : clampPercent(fairPlayRaw))
    : 0;

  const highestLevelAchieved = deriveHighestLevel(profile, stats);
  const normalizedEarnings = normalizeEarnings(raw.earnings || {}, stats);
  const normalizedTotalWinnings = Math.max(
    round1(totalWinnings),
    round1(normalizedEarnings.career)
  );

  const metrics = {
    matches: totalMatches,
    wins: gamesWon,
    score,
    earnings: asInt(normalizedTotalWinnings, 0),
    streak: bestWinStreak,
    acceptance: asInt(matchAcceptancePercentage, 0),
    fair_play: asInt(fairPlayPercent, 0),
  };

  const achievements = buildAchievements(metrics);

  const achievementSummary = {
    totalMatches,
    winPercentage: round1(winPercentage),
    disputePercentage: round1(disputePercentage),
    disputeWinPercentage: round1(disputeWinPercentage),
    matchAcceptancePercentage: round1(matchAcceptancePercentage),
    refusalPercentage: round1(refusalPercentage),
    fairPlayPercentage: round1(fairPlayPercent),
    highestLevelAchieved,
  };

  const normalizedProfile = normalizeAvatarProfile(profile, { stampNow: false });

  raw.profile = {
    ...normalizedProfile,
    disputePercentage: achievementSummary.disputePercentage,
    disputeWinPercentage: achievementSummary.disputeWinPercentage,
    matchAcceptancePercentage: achievementSummary.matchAcceptancePercentage,
    refusalPercentage: achievementSummary.refusalPercentage,
    highestLevelAchieved,
  };

  raw.stats = {
    ...stats,
    score,
    totalWinnings: normalizedTotalWinnings,
    bestWinStreak,
    gamesWon,
    gamesLost,
    gamesDrawn,
    totalMatches,
    winRate: achievementSummary.winPercentage,
    disputeHistoryCount: disputes,
    disputesWon,
    disputeWins: disputesWon,
    acceptedChallenges,
    declinedChallenges,
    matchesAccepted: acceptedChallenges,
    matchesRefused: declinedChallenges,
    highestLevelAchieved,
    achievementSummary,
    achievements,
  };
  raw.earnings = normalizedEarnings;

  return raw;
}

function normalizeCategory(raw) {
  const k = norm(raw);
  if (k === "youth") return "youth";
  if (k === "ladies" || k === "women" || k === "female") return "ladies";
  if (k === "men" || k === "male" || k === "boys") return "men";
  if (k === "seniors" || k === "senior") return "seniors";
  if (k === "masters" || k === "master") return "masters";
  return "global";
}

function normalizeScope(raw) {
  const k = norm(raw);
  if (k === "country") return "country";
  if (k === "region" || k === "state" || k === "county") return "region";
  return "global";
}

// Phase A: money-based ranking. Default remains "score" so the existing
// leaderboard behaviour is unchanged; "money" ranks by total winnings/earnings.
// Exported for unit testing of the pure ranking logic.
export function normalizeSortBy(raw) {
  const k = norm(raw);
  if (
    k === "money" ||
    k === "winnings" ||
    k === "earnings" ||
    k === "prize" ||
    k === "prizemoney" ||
    k === "prize_money"
  ) {
    return "money";
  }
  return "score";
}

// Robust "money earned" resolver. Returns the highest of the three parallel
// cumulative-earnings trackers and is never negative / never NaN / never
// Infinity.
//
// Why max of exactly these three (and NOT earnings.availableBalance):
//   - matchController.js (1v1) and levelEconomy.controller.js (level matches)
//     increment earnings.career + stats.totalWinnings and set earnings.total
//     together by the same payout, so they are designed to be equal.
//   - referral.service.js credits earnings.career + earnings.total but NOT
//     stats.totalWinnings, so career/total can legitimately exceed totalWinnings.
//     max() recovers that real earned money instead of under-counting it.
//   - dispute.controller.js moves all three together (can decrease them).
//   - Deposits / refunds / stake-locks touch ONLY earnings.availableBalance,
//     which is spendable balance — NOT money earned — so it is excluded here.
// Exported for unit testing of the pure ranking logic.
export function resolveMoneyEarned(u = {}) {
  const candidates = [
    u?.stats?.totalWinnings,
    u?.earnings?.career,
    u?.earnings?.total,
  ];
  let best = 0;
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

// Absolute, request-stable tiebreak so the same data always produces the same
// order regardless of the order Mongo returns documents in.
function compareById(a, b) {
  return String(a?._id || "").localeCompare(String(b?._id || ""));
}

// Score-based ordering — this is the EXACT legacy leaderboard ordering, just
// named and extracted so it can be unit tested and reused as a tiebreak.
// Exported for testing.
export function compareByScore(a, b) {
  const as = Number(a?.stats?.score || 0);
  const bs = Number(b?.stats?.score || 0);
  if (bs !== as) return bs - as;

  const aw = Number(a?.stats?.totalWinnings || 0);
  const bw = Number(b?.stats?.totalWinnings || 0);
  if (bw !== aw) return bw - aw;

  const ag = Number(a?.stats?.gamesWon || 0);
  const bg = Number(b?.stats?.gamesWon || 0);
  if (bg !== ag) return bg - ag;

  const byName = displayName(a).localeCompare(displayName(b));
  if (byName !== 0) return byName;
  return compareById(a, b);
}

// Money-based ordering — primary key is money earned, then it falls back to the
// full score-based ordering so ties resolve deterministically. Exported for
// testing.
export function compareByMoney(a, b) {
  const am = resolveMoneyEarned(a);
  const bm = resolveMoneyEarned(b);
  if (bm !== am) return bm - am;
  return compareByScore(a, b);
}

// Picks the comparator for a normalized sortBy value. Exported for testing.
export function makeLeaderboardComparator(sortBy) {
  return sortBy === "money" ? compareByMoney : compareByScore;
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

function ageFromRaw(ageLike) {
  if (ageLike === null || ageLike === undefined || ageLike === "") return -1;
  const n = Number(ageLike);
  if (!Number.isFinite(n)) return -1;
  const age = Math.round(n);
  if (age < 0 || age > 130) return -1;
  return age;
}

function ageFromProfile(profile = {}) {
  const dobCandidate =
    profile?.dateOfBirth ??
    profile?.dob ??
    profile?.birthDate ??
    profile?.birth_date;

  const fromDob = ageFromDob(dobCandidate);
  if (fromDob >= 0) return fromDob;

  return ageFromRaw(
    profile?.age ??
      profile?.ageYears ??
      profile?.userAge
  );
}

function dateOfBirthFromAge(ageRaw) {
  const ageNum = Number(ageRaw);
  if (!Number.isFinite(ageNum)) return null;
  const age = Math.round(ageNum);
  if (age < 13 || age > 120) return null;
  const now = new Date();
  return new Date(now.getFullYear() - age, now.getMonth(), now.getDate());
}

function normalizeGender(v) {
  const s = norm(v);
  if (!s) return "";
  if (["m", "male", "man", "men", "boy"].includes(s)) return "male";
  if (["f", "female", "woman", "women", "lady", "girl"].includes(s)) {
    return "female";
  }
  return "other";
}

function firstNonEmpty(values = []) {
  for (const v of values) {
    const s = toStr(v);
    if (s) return s;
  }
  return "";
}

const MONTH_LABELS = Object.freeze([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);

function monthIndexFromAny(raw) {
  if (raw === null || raw === undefined) return -1;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.round(raw);
    if (n >= 0 && n <= 11) return n;
    if (n >= 1 && n <= 12) return n - 1;
  }

  const s = String(raw).trim().toLowerCase();
  if (!s) return -1;

  const short = s.slice(0, 3);
  const idx = MONTH_LABELS.findIndex((m) => m.toLowerCase() === short);
  return idx >= 0 ? idx : -1;
}

function normalizeYearToDate(rawYearToDate) {
  const out = Array.from({ length: 12 }, () => 0);

  if (Array.isArray(rawYearToDate)) {
    if (rawYearToDate.every((v) => typeof v !== "object")) {
      for (let i = 0; i < Math.min(12, rawYearToDate.length); i += 1) {
        out[i] = Math.max(0, asNum(rawYearToDate[i], 0));
      }
      return out;
    }

    for (const item of rawYearToDate) {
      if (!item || typeof item !== "object") continue;
      const idx = monthIndexFromAny(item.month ?? item.monthIndex ?? item.index);
      if (idx < 0) continue;
      out[idx] = Math.max(0, asNum(item.amount ?? item.value ?? item.total, 0));
    }
    return out;
  }

  if (rawYearToDate && typeof rawYearToDate === "object") {
    for (const [k, v] of Object.entries(rawYearToDate)) {
      const idx = monthIndexFromAny(k);
      if (idx < 0) continue;
      out[idx] = Math.max(0, asNum(v, 0));
    }
  }

  return out;
}

function monthlyFromYearToDate(yearToDate = []) {
  return MONTH_LABELS.map((month, i) => ({
    month,
    amount: round1(Math.max(0, asNum(yearToDate[i], 0))),
  }));
}

function normalizeEarnings(earningsLike = {}, stats = {}) {
  const input = earningsLike && typeof earningsLike === "object"
    ? { ...earningsLike }
    : {};

  const yearToDate = normalizeYearToDate(input.yearToDate || input.ytd || input.monthly);
  const ytdTotal = round1(yearToDate.reduce((sum, v) => sum + Math.max(0, asNum(v, 0)), 0));

  const statsWinnings = round1(Math.max(0, asNum(stats?.totalWinnings, 0)));
  const careerRaw = round1(Math.max(0, asNum(input.career, 0)));
  const career = Math.max(careerRaw, statsWinnings, ytdTotal);

  const totalRaw = round1(Math.max(0, asNum(input.total, 0)));
  const total = Math.max(totalRaw, career);

  const availableBalance = round1(Math.max(0, asNum(input.availableBalance, 0)));
  const entryFeesPaid = round1(Math.max(0, asNum(input.entryFeesPaid, 0)));
  const withdrawable =
    typeof input.withdrawable === "boolean" ? input.withdrawable : true;

  return {
    yearToDate: yearToDate.map((v) => round1(v)),
    monthly: monthlyFromYearToDate(yearToDate),
    yearToDateTotal: ytdTotal,
    career: round1(career),
    total: round1(total),
    availableBalance,
    entryFeesPaid,
    withdrawable,
    transactionHistory: Array.isArray(input.transactionHistory)
      ? input.transactionHistory
      : [],
  };
}

function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 5) return 5;
  return Math.round(n * 10) / 10;
}

function resolveFeedbackText(row = {}) {
  return firstNonEmpty([
    row.feedback,
    row.message,
    row.text,
    row.comment,
    row.review,
  ]);
}

function feedbackCreatedAt(row = {}) {
  const raw = row.createdAt || row.updatedAt || null;
  if (!raw) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function feedbackFromUserSlim(u = null) {
  if (!u || typeof u !== "object") return null;
  const normalized = normalizeUserForClient(u);
  const profile = normalized?.profile || {};
  const stats = normalized?.stats || {};

  return {
    _id: toStr(normalized?._id),
    username: toStr(normalized?.username),
    avatar: toStr(resolveAvatarUrl(normalized)),
    avatarUrl: toStr(resolveAvatarUrl(normalized)),
    avatarUpdatedAt: toStr(profile?.avatarUpdatedAt),
    profile: {
      nickname: toStr(profile?.nickname),
      name: toStr(profile?.name),
      avatar: toStr(resolveAvatarUrl(normalized)),
      avatarUrl: toStr(resolveAvatarUrl(normalized)),
      avatarUpdatedAt: toStr(profile?.avatarUpdatedAt),
      highestLevelAchieved: asInt(
        profile?.highestLevelAchieved ?? stats?.highestLevelAchieved,
        0
      ),
    },
    stats: {
      score: asInt(stats?.score, 0),
      highestLevelAchieved: asInt(stats?.highestLevelAchieved, 0),
      rank: toStr(stats?.rank),
    },
  };
}

function normalizeFeedbackRow(row = {}, fromUser = null) {
  const text = resolveFeedbackText(row);
  const fromUserSlim = feedbackFromUserSlim(fromUser);
  const fallbackName = cleanPublicName(row?.name) || "Player";
  const name = fromUserSlim
    ? displayName(fromUserSlim)
    : fallbackName;

  const avatar = fromUserSlim?.avatar || toStr(row?.avatar) || toStr(row?.avatarUrl);
  const avatarUpdatedAt =
    toStr(fromUserSlim?.avatarUpdatedAt) || toStr(row?.avatarUpdatedAt);

  return {
    _id: toStr(row?._id),
    fromUserId: toStr(row?.fromUserId),
    matchId: toStr(row?.matchId),
    name,
    feedback: text,
    message: text,
    text,
    comment: text,
    review: text,
    rating: clampRating(row?.rating),
    avatar,
    avatarUrl: avatar,
    avatarUpdatedAt,
    createdAt: feedbackCreatedAt(row),
    fromUser: fromUserSlim,
  };
}

function resolveCountry(u = {}) {
  const p = u.profile || {};
  const loc = u.location || {};
  return firstNonEmpty([
    p.country,
    p.countryName,
    p.countryCode,
    u.country,
    u.countryName,
    u.countryCode,
    loc.country,
    loc.countryName,
    loc.countryCode,
  ]);
}

function resolveRegion(u = {}) {
  const p = u.profile || {};
  const loc = u.location || {};
  return firstNonEmpty([
    p.region,
    p.state,
    p.county,
    p.province,
    u.region,
    u.state,
    u.county,
    u.province,
    loc.region,
    loc.state,
    loc.county,
    loc.province,
  ]);
}

function displayName(u = {}) {
  const p = u.profile || {};
  const firstLast = cleanPublicName(
    `${toStr(p.firstName)} ${toStr(p.lastName)}`.trim()
  );

  return firstNonEmpty([
    cleanPublicName(u.username),
    cleanPublicName(p.nickname),
    cleanPublicName(p.name),
    firstLast,
    "Player",
  ]);
}

function includeByCategory(u = {}, category = "global") {
  if (category === "global") return true;
  const p = u.profile || {};
  let age = ageFromProfile(p);
  if (age < 0) {
    age = ageFromDob(
      u?.dateOfBirth ??
      u?.dob ??
      u?.birthDate ??
      u?.birth_date
    );
  }
  if (age < 0) {
    age = ageFromRaw(
      u?.age ??
      u?.ageYears ??
      u?.userAge
    );
  }

  if (category === "youth") return age >= 0 && age < 18;
  if (category === "seniors") return age >= 40;
  if (category === "masters") return age >= 50;
  if (category === "ladies") {
    const g = norm(p.gender);
    return ["f", "female", "woman", "women", "lady", "girl"].includes(g);
  }
  if (category === "men") {
    const g = norm(p.gender);
    return ["m", "male", "man", "men", "boy"].includes(g);
  }
  return true;
}

function resolveAgeForUser(u = {}) {
  const p = u.profile || {};
  let age = ageFromProfile(p);
  if (age >= 0) return age;

  age = ageFromDob(
    u?.dateOfBirth ??
    u?.dob ??
    u?.birthDate ??
    u?.birth_date
  );
  if (age >= 0) return age;

  return ageFromRaw(
    u?.age ??
    u?.ageYears ??
    u?.userAge
  );
}

function includeByScope(u = {}, scope = "global", viewerCountry = "", viewerRegion = "") {
  if (scope === "global") return true;

  const rowCountry = norm(resolveCountry(u));
  const rowRegion = norm(resolveRegion(u));
  const vc = norm(viewerCountry);
  const vr = norm(viewerRegion);

  if (scope === "country") {
    if (!vc) return true;
    return !!rowCountry && rowCountry === vc;
  }

  // region scope
  if (vc && rowCountry && rowCountry !== vc) return false;
  if (!vr) return true;
  return !!rowRegion && rowRegion === vr;
}

export async function leaderboard(req, res) {
  try {
    const q = req.query || {};
    const category = normalizeCategory(q.filter || q.category || q.group);
    const scope = normalizeScope(q.scope || q.geoScope || q.locationScope);
    const sortBy = normalizeSortBy(q.sortBy || q.rankBy || q.sort || q.orderBy);
    const limitRaw = Number(q.limit || 100);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(500, Math.round(limitRaw)))
      : 100;

    const viewerProfile = req?.user?.profile || {};
    const viewerCountry = firstNonEmpty([
      q.country,
      q.countryCode,
      viewerProfile.country,
      viewerProfile.countryCode,
      viewerProfile.countryName,
    ]);
    const viewerRegion = firstNonEmpty([
      q.region,
      q.state,
      q.county,
      viewerProfile.region,
      viewerProfile.state,
      viewerProfile.county,
      viewerProfile.province,
    ]);

    const users = await User.find({})
      .select(
        [
          "_id",
          "username",
          "dateOfBirth",
          "dob",
          "birthDate",
          "birth_date",
          "age",
          "ageYears",
          "userAge",
          "profile.nickname",
          "profile.name",
          "profile.firstName",
          "profile.lastName",
            "profile.avatar",
            "profile.avatarUrl",
            "profile.photo",
            "profile.profileImage",
            "profile.profilePic",
            "profile.photoUrl",
            "profile.imageUrl",
            "profile.image",
            "profile.userAvatar",
            "profile.avatarPath",
            "profile.avatarUpdatedAt",
            "profile.gender",
            "profile.dateOfBirth",
          "profile.dob",
          "profile.birthDate",
          "profile.birth_date",
          "profile.age",
          "profile.ageYears",
          "profile.userAge",
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
            "stats.rank",
            "stats.userIdTag",
            "earnings.career",
            "earnings.total",
            "avatar",
            "avatarUrl",
            "photo",
            "profileImage",
            "profilePic",
            "photoUrl",
            "image",
            "imageUrl",
            "userAvatar",
            "avatarPath",
        ].join(" ")
      )
      .lean();

    const filtered = users
      .filter((u) => includeByCategory(u, category))
      .filter((u) => includeByScope(u, scope, viewerCountry, viewerRegion));

    filtered.sort(makeLeaderboardComparator(sortBy));

    // Viewer's own standing across the full sorted+filtered set, so a player can
    // see their rank even when they fall outside the returned slice. Additive —
    // never affects the leaderboard array itself.
    const viewerId = String(req.userId || req?.user?._id || "").trim();
    let viewerStanding = null;
    if (viewerId) {
      const viewerIdx = filtered.findIndex((u) => String(u._id) === viewerId);
      if (viewerIdx >= 0) {
        const vu = filtered[viewerIdx];
        viewerStanding = {
          rank: viewerIdx + 1,
          total: filtered.length,
          userId: viewerId,
          score: Number(vu?.stats?.score || 0),
          moneyEarned: resolveMoneyEarned(vu),
          inTopList: viewerIdx < limit,
        };
      }
    }

    const leaderboard = filtered.slice(0, limit).map((u, idx) => {
      const points = Number(u?.stats?.score || 0);
      const winnings = Number(u?.stats?.totalWinnings || 0);
      const moneyEarned = resolveMoneyEarned(u);
      const country = resolveCountry(u);
      const region = resolveRegion(u);
      const avatarUrl = resolveAvatarUrl(u);
      const avatarUpdatedAt = toStr(u?.profile?.avatarUpdatedAt);
      const age = resolveAgeForUser(u);

      return {
        rank: idx + 1,
        userId: String(u._id),
        name: displayName(u),
        username: toStr(u.username),
        age: age >= 0 ? age : null,
        avatar: toStr(avatarUrl),
        avatarUrl: toStr(avatarUrl),
        avatarUpdatedAt,
        points,
        score: points,
        totalWinnings: winnings,
        winnings,
        moneyEarned,
        country,
        region,
        stats: {
          score: points,
          totalWinnings: winnings,
          rank: toStr(u?.stats?.rank),
          userIdTag: toStr(u?.stats?.userIdTag),
        },
      };
    });

    return res.json({
      leaderboard,
      viewer: viewerStanding,
      meta: {
        category,
        scope,
        sortBy,
        count: leaderboard.length,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to load leaderboard" });
  }
}

// Phase D: consolidated player dashboard — one call that aggregates the
// profile/stats/money/counts a player home screen needs, instead of the client
// fanning out to /me + /earnings + /ledger/me/summary + entry list. Additive;
// all existing endpoints are unchanged.
export async function dashboard(req, res) {
  try {
    const userId = String(req.userId || req.user?._id || "").trim();
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const currency = "GBP";

    const [user, walletRows, tournamentsEntered, activeHolds] = await Promise.all([
      User.findById(userId).select("username profile stats earnings").lean(),
      LedgerEntry.aggregate([
        {
          $match: {
            accountType: "USER_WALLET",
            accountId: userId,
            currency,
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
      ]),
      TournamentEntryOrder.countDocuments({ userId, status: "PAID" }),
      WalletHold.countDocuments({ userId, status: "HELD" }),
    ]);

    if (!user) return res.status(404).json({ ok: false, message: "User not found" });

    const wr = walletRows[0] || { debitMinor: 0, creditMinor: 0 };
    const walletBalanceMinor = Number(wr.creditMinor || 0) - Number(wr.debitMinor || 0);
    const stats = user.stats || {};
    const earnings = user.earnings || {};

    return res.json({
      ok: true,
      dashboard: {
        profile: {
          userId,
          name: displayName(user),
          username: toStr(user.username),
          rank: toStr(stats.rank),
          avatar: resolveAvatarUrl(user),
        },
        stats: {
          score: Number(stats.score || 0),
          totalWinnings: Number(stats.totalWinnings || 0),
          gamesWon: Number(stats.gamesWon || 0),
          gamesLost: Number(stats.gamesLost || 0),
          totalMatches: Number(stats.totalMatches || 0),
          winRate: Number(stats.winRate || 0),
          currentWinStreak: Number(stats.currentWinStreak || 0),
        },
        money: {
          currency,
          moneyEarned: resolveMoneyEarned(user),
          career: Number(earnings.career || 0),
          total: Number(earnings.total || 0),
          availableBalance: Number(earnings.availableBalance || 0),
          walletBalanceMinor,
        },
        counts: {
          tournamentsEntered,
          activeHolds,
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load dashboard" });
  }
}

export async function me(req, res) {
  try {
    let user = req.user;

    if (!user && req.userId) {
      user = await User.findById(req.userId).select("-passwordHash -otp");
    }

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      user: normalizeUserForClient(user),
      club: safeClub(req.club || null),
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteMyAccount(req, res) {
  try {
    const userId = String(req.userId || req.user?._id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const user = await User.findById(userId).select("_id username stats.userIdTag");
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    const uid = user._id;
    const uidText = String(uid);
    const username = String(user.username || "").trim();
    const userIdTag = String(user?.stats?.userIdTag || "").trim();

    await FriendRequest.deleteMany({ $or: [{ from: uid }, { to: uid }] });
    await Friendship.deleteMany({ $or: [{ a: uid }, { b: uid }] });

    await Match.deleteMany({
      $or: [{ players: uid }, { winner: uid }, { "score.user": uid }],
    });

    await LevelMatchmakingState.deleteMany({ userId: uid });
    await LevelMatchSession.deleteMany({
      $or: [
        { participants: uid },
        { challengerUserId: uid },
        { opponentUserId: uid },
        { winnerUserId: uid },
        { loserUserId: uid },
        { createdByUserId: uid },
      ],
    });

    await StoreOrder.deleteMany({ userId: uid });
    await PaymentIntent.deleteMany({ userId: uid });
    await WalletHold.deleteMany({ userId: uid });
    await Payout.deleteMany({ userId: uid });
    await TournamentEntryOrder.deleteMany({ userId: uid });
    await TournamentInvite.deleteMany({ toUserId: uid });
    await UserEntitlement.deleteMany({ userId: uid });
    await UserLoadout.deleteMany({ userId: uid });
    await PrizeAward.deleteMany({ userId: uid });
    await ReferralCommission.deleteMany({
      $or: [{ referrerUserId: uid }, { referredUserId: uid }],
    });
    await Transaction.deleteMany({ user: uid });

    await DisputeCase.deleteMany({
      $or: [
        { openedByUserId: uid },
        { respondentUserId: uid },
        { "comments.actorUserId": uid },
        { "evidence.uploadedByUserId": uid },
        { "resolution.decidedByUserId": uid },
      ],
    });

    await LedgerEntry.deleteMany({
      $or: [
        { accountType: "USER_WALLET", accountId: uidText },
        { accountType: "REFERRAL_COMMISSION", accountId: uidText },
        { "metadata.userId": uidText },
        ...(userIdTag ? [{ "metadata.userIdTag": userIdTag }] : []),
      ],
    });

    await User.updateMany({ friends: uid }, { $pull: { friends: uid } });
    await User.updateMany(
      { "feedbacks.fromUserId": uid },
      { $pull: { feedbacks: { fromUserId: uid } } }
    );
    await User.updateMany(
      { "referral.referredByUserId": uid },
      {
        $set: {
          "referral.referredByUserId": null,
          "referral.referredByCode": "",
          "referral.referredAt": null,
        },
      }
    );

    await Club.updateMany({ owner: uid }, { $unset: { owner: "" } });

    await Tournament.updateMany(
      { "entrants.entrantId": uid },
      { $pull: { entrants: { entrantId: uid } } }
    );
    await Tournament.updateMany(
      { "entrants.userId": uidText },
      { $pull: { entrants: { userId: uidText } } }
    );
    if (username) {
      await Tournament.updateMany(
        { "entrants.username": username },
        { $pull: { entrants: { username } } }
      );
    }

    const deleted = await User.deleteOne({ _id: uid });
    if (!deleted || Number(deleted.deletedCount || 0) < 1) {
      return res.status(500).json({
        ok: false,
        message:
          "We could not complete account deletion. Please try again.",
      });
    }

    return res.json({
      ok: true,
      message: "Account deleted permanently",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error?.message ||
        "We could not complete account deletion right now. Please try again.",
    });
  }
}

// SECURITY: the ONLY profile fields a client may set via PATCH /api/user/me.
// Everything else — role, isAdmin, isPlatformAdmin, organizer, fairPlay,
// verification/KYC status, etc. — is server-controlled and must never be
// mass-assigned from the request body. (earnings/stats/score are also
// server-only and are not accepted here at all.)
const CLIENT_EDITABLE_PROFILE_KEYS = new Set([
  "name",
  "legalName",
  "firstName",
  "lastName",
  "nickname",
  "homeTable",
  "musicPlayer",
  "minLevel",
  "maxLevel",
  "gender",
  "dateOfBirth",
  "dob",
  "birthDate",
  "age",
  "country",
  "countryCode",
  "countryName",
  "region",
  "state",
  "county",
  "province",
]);

function pickEditableProfile(src) {
  const out = {};
  if (src && typeof src === "object") {
    for (const k of Object.keys(src)) {
      if (CLIENT_EDITABLE_PROFILE_KEYS.has(k)) out[k] = src[k];
    }
  }
  return out;
}

export async function updateProfile(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const payload = req.body || {};

    // SECURITY: only merge an allow-list of editable fields from the client's
    // profile object — never the whole thing (prevents privilege escalation via
    // role/isPlatformAdmin/organizer/etc.).
    let nextProfile = mergePlainObject(
      user.profile || {},
      pickEditableProfile(payload.profile)
    );

    const directName = normalizeName(payload.name);
    const directNickname = toStr(payload.nickname);
    const directHomeTable = toStr(payload.homeTable);

    if (payload.musicPlayer !== undefined) {
      nextProfile.musicPlayer = !!payload.musicPlayer;
    }

    if (payload.gender !== undefined) {
      const normalizedGender = normalizeGender(payload.gender);
      if (!normalizedGender) {
        return res.status(400).json({ message: "Invalid gender" });
      }
      nextProfile.gender = normalizedGender;
    }

    if (payload.dateOfBirth !== undefined) {
      const dob = new Date(payload.dateOfBirth);
      if (Number.isNaN(dob.getTime())) {
        return res.status(400).json({ message: "Invalid dateOfBirth" });
      }
      nextProfile.dateOfBirth = dob;
    }

    if (payload.age !== undefined) {
      const dob = dateOfBirthFromAge(payload.age);
      if (!dob) {
        return res.status(400).json({ message: "Invalid age (13-120)" });
      }
      nextProfile.dateOfBirth = dob;
    }

    if (directNickname) {
      nextProfile.nickname = directNickname;
    }

    if (directHomeTable) {
      nextProfile.homeTable = directHomeTable;
    }

    if (payload.minLevel !== undefined) {
      const minLevel = Number(payload.minLevel);
      if (Number.isFinite(minLevel)) nextProfile.minLevel = Math.max(1, Math.round(minLevel));
    }

    if (payload.maxLevel !== undefined) {
      const maxLevel = Number(payload.maxLevel);
      if (Number.isFinite(maxLevel)) nextProfile.maxLevel = Math.max(1, Math.round(maxLevel));
    }

    if (payload.firstName !== undefined || payload.lastName !== undefined || payload.legalName !== undefined || directName) {
      const firstName = payload.firstName !== undefined
        ? normalizeName(payload.firstName)
        : normalizeName(nextProfile.firstName);
      const lastName = payload.lastName !== undefined
        ? normalizeName(payload.lastName)
        : normalizeName(nextProfile.lastName);

      const legalName = payload.legalName !== undefined
        ? normalizeName(payload.legalName)
        : (directName || normalizeName(nextProfile.legalName));

      if (firstName) nextProfile.firstName = firstName;
      if (lastName) nextProfile.lastName = lastName;

      if (legalName) {
        nextProfile.legalName = legalName;
      } else {
        const joined = normalizeName(`${firstName} ${lastName}`);
        if (joined) nextProfile.legalName = joined;
      }

      if (directName) {
        nextProfile.name = directName;
      }
    }

    if (directName && !nextProfile.firstName && !nextProfile.lastName) {
      const parsed = splitName(directName);
      if (parsed.firstName) nextProfile.firstName = parsed.firstName;
      if (parsed.lastName) nextProfile.lastName = parsed.lastName;
      if (!nextProfile.legalName) nextProfile.legalName = directName;
      nextProfile.name = directName;
    }

    nextProfile = normalizeAvatarProfile(nextProfile, { stampNow: false });
    user.profile = nextProfile;

    // SECURITY: earnings and stats are server-controlled (set by match results,
    // settlements and the ledger). They are deliberately NOT accepted from the
    // client here — accepting them allowed wallet/leaderboard manipulation.

    if (payload.username !== undefined) {
      const { username, lower } = normalizeUsername(payload.username);

      if (!username) {
        return res.status(400).json({ code: "USERNAME_REQUIRED", message: "Username is required" });
      }

      const validationError = validateUsername(username);
      if (validationError) {
        return res.status(400).json({ code: "INVALID_USERNAME", message: validationError });
      }

      const conflict = await User.findOne({ usernameLower: lower, _id: { $ne: user._id } }).select("_id");
      if (conflict) {
        return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
      }

      user.username = username;
    }

    if (req.file) {
      // Fast-fail with a precise reason when image hosting isn't configured,
      // rather than attempting (and awaiting) a doomed upload.
      if (!isCloudinaryConfigured()) {
        console.warn("Avatar upload attempted but Cloudinary is not configured.");
        return res.status(502).json({
          code: "AVATAR_UPLOAD_UNAVAILABLE",
          message:
            "Profile photo upload isn't available right now. Please try again later.",
        });
      }

      let result;
      try {
        result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "profile_pics",
              transformation: [{ width: 400, height: 400, crop: "fill", gravity: "auto" }],
            },
            (uploadError, uploadResult) => {
              if (uploadError) reject(uploadError);
              else resolve(uploadResult);
            }
          );

          stream.end(req.file.buffer);
        });
      } catch (uploadErr) {
        // Surface a clear, specific error instead of a generic 500 so the cause
        // (e.g. image hosting / Cloudinary not configured) is diagnosable and the
        // client can show a meaningful message.
        console.log("Avatar upload failed:", uploadErr?.message || uploadErr);
        return res.status(502).json({
          code: "AVATAR_UPLOAD_FAILED",
          message:
            "Profile photo upload failed. Image hosting is not available right now. Please try again later.",
        });
      }

      user.profile = user.profile || {};
      user.profile.avatar = result.secure_url;
      user.profile.avatarUrl = result.secure_url;
      user.profile.photo = result.secure_url;
      user.profile.profileImage = result.secure_url;
      user.profile.avatarUpdatedAt = new Date();
    }

    const normalizedForSave = normalizeUserForClient(user);
    user.profile = normalizedForSave.profile || {};
    user.stats = normalizedForSave.stats || {};

    await user.save();

    const safeUser = await User.findById(user._id).select("-passwordHash -otp");

    return res.json({
      user: normalizeUserForClient(safeUser),
      club: safeClub(req.club || null),
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    if (error?.code === 11000) {
      const keyPattern = error?.keyPattern || {};
      if (keyPattern.username || keyPattern.usernameLower) {
        return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
      }
    }

    console.log("Error in updateProfile", error.message);
    return res.status(500).json({ message: error.message });
  }
}

export async function listFeedback(req, res) {
  try {
    const targetId = toStr(req.query?.userId || req.userId);
    if (!targetId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const target = await User.findById(targetId).select("feedbacks");
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    const rows = Array.isArray(target.feedbacks)
      ? target.feedbacks.map((f) =>
          f && typeof f.toObject === "function" ? f.toObject() : { ...(f || {}) }
        )
      : [];

    const fromIds = rows
      .map((f) => toStr(f?.fromUserId))
      .filter((v) => v.length > 0);

    const uniqueFromIds = Array.from(new Set(fromIds));
    const fromUsers = uniqueFromIds.length
      ? await User.find({ _id: { $in: uniqueFromIds } })
          .select(
            [
              "_id",
              "username",
              "profile.nickname",
              "profile.name",
              "profile.avatar",
              "profile.avatarUrl",
              "profile.photo",
              "profile.profileImage",
              "profile.avatarUpdatedAt",
              "profile.highestLevelAchieved",
              "stats.score",
              "stats.rank",
              "stats.highestLevelAchieved",
            ].join(" ")
          )
          .lean()
      : [];

    const fromMap = new Map(fromUsers.map((u) => [toStr(u?._id), u]));

    const feedbacks = rows
      .map((row) => {
        const fromUser = fromMap.get(toStr(row?.fromUserId)) || null;
        return normalizeFeedbackRow(row, fromUser);
      })
      .sort((a, b) => {
        const at = new Date(a.createdAt || 0).getTime();
        const bt = new Date(b.createdAt || 0).getTime();
        return bt - at;
      });

    const ratings = feedbacks
      .map((f) => Number(f.rating || 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const avgRating = ratings.length
      ? Math.round((ratings.reduce((sum, n) => sum + n, 0) / ratings.length) * 10) / 10
      : 0;

    return res.json({
      feedbacks,
      meta: {
        count: feedbacks.length,
        ratingCount: ratings.length,
        avgRating,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to load feedback" });
  }
}

export async function createFeedback(req, res) {
  try {
    const payload = req.body || {};
    const targetId = toStr(
      payload.toUserId ||
        payload.userId ||
        payload.targetUserId ||
        payload.playerId
    );

    if (!targetId) {
      return res.status(400).json({ message: "toUserId is required" });
    }

    if (toStr(req.userId) && toStr(req.userId) === targetId) {
      return res.status(400).json({ message: "You cannot review yourself" });
    }

    const text = resolveFeedbackText(payload);
    if (!text) {
      return res.status(400).json({ message: "Feedback text is required" });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ message: "Target user not found" });
    }

    const author = req.userId
      ? await User.findById(req.userId)
          .select(
            [
              "_id",
              "username",
              "profile.nickname",
              "profile.name",
              "profile.avatar",
              "profile.avatarUrl",
              "profile.photo",
              "profile.profileImage",
              "profile.avatarUpdatedAt",
              "profile.highestLevelAchieved",
              "stats.score",
              "stats.rank",
              "stats.highestLevelAchieved",
            ].join(" ")
          )
      : null;

    const authorName = author
      ? displayName(author)
      : firstNonEmpty([toStr(payload.name), "Player"]);
    const authorAvatar = author
      ? toStr(resolveAvatarUrl(author))
      : firstNonEmpty([toStr(payload.avatar), toStr(payload.avatarUrl)]);

    const now = new Date();
    const row = {
      fromUserId: author?._id || null,
      matchId: toStr(payload.matchId),
      name: authorName,
      avatar: authorAvatar,
      avatarUrl: authorAvatar,
      avatarUpdatedAt: author?.profile?.avatarUpdatedAt || null,
      feedback: text,
      message: text,
      text,
      comment: text,
      review: text,
      rating: clampRating(payload.rating),
      createdAt: now,
      updatedAt: now,
    };

    target.feedbacks = Array.isArray(target.feedbacks) ? target.feedbacks : [];
    target.feedbacks.push(row);
    await target.save();

    return res.status(201).json({
      message: "Feedback submitted",
      feedback: normalizeFeedbackRow(row, author),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to submit feedback" });
  }
}

export async function getEarnings(req, res) {
  try {
    const user = await User.findById(req.userId).select(
      [
        "_id",
        "username",
        "profile.nickname",
        "profile.name",
        "profile.firstName",
        "profile.lastName",
        "stats.totalWinnings",
        "stats.score",
        "stats.rank",
        "earnings",
      ].join(" ")
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const normalizedUser = normalizeUserForClient(user);
    const earnings = normalizeEarnings(
      normalizedUser?.earnings || {},
      normalizedUser?.stats || {}
    );

    return res.json({
      earnings,
      stats: {
        totalWinnings: asNum(normalizedUser?.stats?.totalWinnings, 0),
        score: asInt(normalizedUser?.stats?.score, 0),
        rank: toStr(normalizedUser?.stats?.rank),
      },
      meta: {
        year: new Date().getFullYear(),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to load earnings" });
  }
}

export async function nearestPlayers(req, res) {
  try {
    const users = await User.find({
      "profile.onlineStatus": true,
      _id: { $ne: req.userId },
    })
      .select("-passwordHash -otp")
      .limit(50);

    return res.json({
      users: users.map((u) => normalizeUserForClient(u)),
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
