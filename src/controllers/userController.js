// src/controllers/userController.js
import User from "../models/user.model.js";
import { v2 as cloudinary } from "cloudinary";

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

function validateUsername(username) {
  if (!username) return "Username is required";
  if (!USERNAME_REGEX.test(username)) {
    return "Invalid username. Use 3-20 characters: letters, numbers, underscore.";
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

  const rawWinRate = asNum(stats.winRate, Number.NaN);
  const winPercentage = Number.isFinite(rawWinRate)
    ? clampPercent(rawWinRate)
    : totalMatches > 0
      ? clampPercent((gamesWon * 100) / totalMatches)
      : 0;

  const rawDisputePct = asNum(profile.disputePercentage, Number.NaN);
  const disputePercentage = Number.isFinite(rawDisputePct)
    ? clampPercent(rawDisputePct)
    : totalMatches > 0
      ? clampPercent((disputes * 100) / totalMatches)
      : 0;

  const rawDisputeWinPct = asNum(profile.disputeWinPercentage, Number.NaN);
  const disputeWinPercentage = Number.isFinite(rawDisputeWinPct)
    ? clampPercent(rawDisputeWinPct)
    : disputes > 0
      ? clampPercent((disputesWon * 100) / disputes)
      : 0;

  const rawAcceptance = asNum(profile.matchAcceptancePercentage, Number.NaN);
  const rawRefusal = asNum(profile.refusalPercentage, Number.NaN);
  let matchAcceptancePercentage = 0;
  let refusalPercentage = 0;

  if (Number.isFinite(rawAcceptance) || Number.isFinite(rawRefusal)) {
    matchAcceptancePercentage = Number.isFinite(rawAcceptance)
      ? clampPercent(rawAcceptance)
      : clampPercent(100 - rawRefusal);
    refusalPercentage = Number.isFinite(rawRefusal)
      ? clampPercent(rawRefusal)
      : clampPercent(100 - rawAcceptance);
  } else {
    const totalChallenges = acceptedChallenges + declinedChallenges;
    matchAcceptancePercentage = totalChallenges > 0
      ? clampPercent((acceptedChallenges * 100) / totalChallenges)
      : 0;
    refusalPercentage = totalChallenges > 0
      ? clampPercent((declinedChallenges * 100) / totalChallenges)
      : 0;
  }

  const fairPlayRaw = asNum(profile.fairPlay, 0);
  const fairPlayPercent = fairPlayRaw <= 5
    ? clampPercent(fairPlayRaw * 20)
    : clampPercent(fairPlayRaw);

  const highestLevelAchieved = deriveHighestLevel(profile, stats);

  const metrics = {
    matches: totalMatches,
    wins: gamesWon,
    score,
    earnings: asInt(totalWinnings, 0),
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
    highestLevelAchieved,
  };

  raw.profile = {
    ...profile,
    disputePercentage: achievementSummary.disputePercentage,
    disputeWinPercentage: achievementSummary.disputeWinPercentage,
    matchAcceptancePercentage: achievementSummary.matchAcceptancePercentage,
    refusalPercentage: achievementSummary.refusalPercentage,
    highestLevelAchieved,
  };

  raw.stats = {
    ...stats,
    score,
    totalWinnings,
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

  return raw;
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

export async function updateProfile(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const payload = req.body || {};

    let nextProfile = mergePlainObject(user.profile || {}, payload.profile || {});

    const directName = normalizeName(payload.name);
    const directNickname = toStr(payload.nickname);
    const directHomeTable = toStr(payload.homeTable);

    if (payload.musicPlayer !== undefined) {
      nextProfile.musicPlayer = !!payload.musicPlayer;
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

    user.profile = nextProfile;

    if (payload.feedbacks !== undefined && Array.isArray(payload.feedbacks)) {
      user.feedbacks = payload.feedbacks;
    }

    if (payload.earnings !== undefined && payload.earnings && typeof payload.earnings === "object") {
      user.earnings = mergePlainObject(user.earnings || {}, payload.earnings || {});
    }

    if (payload.stats !== undefined && payload.stats && typeof payload.stats === "object") {
      user.stats = mergePlainObject(user.stats || {}, payload.stats || {});
    }

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
      const result = await new Promise((resolve, reject) => {
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

      user.profile = user.profile || {};
      user.profile.avatar = result.secure_url;
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

export async function nearestPlayers(req, res) {
  try {
    const users = await User.find({
      "profile.onlineStatus": true,
      _id: { $ne: req.userId },
    })
      .select("-passwordHash -otp")
      .limit(50);

    return res.json({
      users,
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
