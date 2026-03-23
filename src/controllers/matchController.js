// src/controllers/matchController.js
import Match from "../models/match.model.js";
import User from "../models/user.model.js";
import Transaction from "../models/transaction.model.js";
import mongoose from "mongoose";

const APP_COMMISSION_RATE = 0.10;
const WINNER_SCORE_BONUS = 25;
const LOSER_SCORE_BONUS = 5;
const MONTH_COUNT = 12;

function toId(v) {
  if (!v) return "";
  return String(v).trim();
}

function sameId(a, b) {
  return toId(a) === toId(b);
}

function includesPlayer(players = [], userId) {
  const uid = toId(userId);
  return players.some((p) => toId(p) === uid);
}

function asNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeYearToDateArray(raw) {
  const out = Array.from({ length: MONTH_COUNT }, () => 0);

  if (Array.isArray(raw)) {
    for (let i = 0; i < Math.min(MONTH_COUNT, raw.length); i += 1) {
      out[i] = Math.max(0, asNumber(raw[i], 0));
    }
    return out;
  }

  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx < 0 || idx >= MONTH_COUNT) continue;
      out[idx] = Math.max(0, asNumber(v, 0));
    }
  }

  return out;
}

async function ensureUserExists(userId, session = null) {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;
  const query = User.findById(userId).select("_id username profile.nickname");
  if (session) query.session(session);
  return await query;
}

// ========================
// 1. CREATE CHALLENGE
// ========================
export async function createChallenge(req, res) {
  try {
    const challenger = toId(req.userId);
    const { opponentId, entryFee, clubId, slot } = req.body;

    const cleanOpponentId = toId(opponentId);
    const cleanClubId = toId(clubId);
    const safeEntryFee = Math.max(0, Number(entryFee || 0));

    if (!challenger) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!cleanOpponentId) {
      return res.status(400).json({ message: "opponentId is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(cleanOpponentId)) {
      return res.status(400).json({ message: "Invalid opponentId" });
    }

    if (sameId(challenger, cleanOpponentId)) {
      return res.status(400).json({ message: "You cannot challenge yourself" });
    }

    const [challengerUser, opponentUser] = await Promise.all([
      ensureUserExists(challenger),
      ensureUserExists(cleanOpponentId),
    ]);

    if (!challengerUser) {
      return res.status(404).json({ message: "Challenger user not found" });
    }

    if (!opponentUser) {
      return res.status(404).json({ message: "Opponent user not found" });
    }

    const existingPending = await Match.findOne({
      players: { $all: [challenger, cleanOpponentId] },
      status: { $in: ["pending", "ongoing"] },
    }).lean();

    if (existingPending) {
      return res.status(409).json({
        message: "There is already an active or pending match between these players",
        matchId: existingPending._id,
      });
    }

    const match = await Match.create({
      players: [challenger, cleanOpponentId],
      status: "pending",
      entryFee: safeEntryFee,
      meta: {
        clubId: cleanClubId || undefined,
        slot: slot || null,
        createdByActorType: req?.auth?.actorType || "user",
      },
    });

    return res.json({ match });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to create challenge",
    });
  }
}

// ========================
// 2. ACCEPT CHALLENGE
// ========================
export async function acceptChallenge(req, res) {
  try {
    const actorId = toId(req.userId);
    const { matchId } = req.body;

    if (!actorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!matchId || !mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({ message: "Valid matchId is required" });
    }

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    if (!includesPlayer(match.players, actorId)) {
      return res.status(403).json({ message: "Only a match participant can accept this challenge" });
    }

    if (match.status !== "pending") {
      return res.status(400).json({ message: "Only pending challenges can be accepted" });
    }

    match.status = "ongoing";
    match.startAt = new Date();
    await match.save();

    const safeEntryFee = Math.max(0, Number(match.entryFee || 0));
    if (safeEntryFee > 0 && Array.isArray(match.players) && match.players.length) {
      await User.updateMany(
        { _id: { $in: match.players } },
        {
          $inc: {
            "earnings.entryFeesPaid": safeEntryFee,
          },
        }
      );
    }

    await User.findByIdAndUpdate(actorId, {
      $inc: {
        "stats.acceptedChallenges": 1,
        "stats.matchesAccepted": 1,
      },
    });

    return res.json({ match });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to accept challenge",
    });
  }
}

// ========================
// 3. FINISH MATCH
// ========================
export async function finishMatch(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const actorId = toId(req.userId);
    const { matchId, winnerId, scores } = req.body;

    if (!actorId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!matchId || !mongoose.Types.ObjectId.isValid(matchId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Valid matchId is required" });
    }

    if (!winnerId || !mongoose.Types.ObjectId.isValid(winnerId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Valid winnerId is required" });
    }

    const match = await Match.findById(matchId).session(session);
    if (!match) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Match not found" });
    }

    if (!includesPlayer(match.players, actorId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Only a participant can finish this match" });
    }

    if (!includesPlayer(match.players, winnerId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "winnerId must belong to this match" });
    }

    if (match.status !== "ongoing") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Match is not ongoing" });
    }

    const loserId = match.players.find((p) => !sameId(p, winnerId));
    if (!loserId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Unable to determine loser" });
    }

    const scoreA = Number(scores?.scoreA ?? scores?.a ?? 0);
    const scoreB = Number(scores?.scoreB ?? scores?.b ?? 0);

    const entryFee = Math.max(0, Number(match.entryFee || 0));
    const totalWager = entryFee * 2;
    const appCommission = totalWager * APP_COMMISSION_RATE;
    const payoutAmount = totalWager - appCommission;

    match.status = "finished";
    match.endAt = new Date();
    match.winner = winnerId;
    match.score = {
      scoreA,
      scoreB,
    };
    await match.save({ session });

    const [winnerUser, loserUser] = await Promise.all([
      User.findById(winnerId)
        .select("stats earnings")
        .session(session),
      User.findById(loserId)
        .select("stats")
        .session(session),
    ]);

    const winnerPrevWon = Number(winnerUser?.stats?.gamesWon || 0);
    const winnerPrevLost = Number(winnerUser?.stats?.gamesLost || 0);
    const winnerPrevDraw = Number(winnerUser?.stats?.gamesDrawn || 0);
    const winnerPrevTotal = Number(
      winnerUser?.stats?.totalMatches ||
      winnerPrevWon + winnerPrevLost + winnerPrevDraw
    );
    const winnerPrevCurrentStreak = Number(winnerUser?.stats?.currentWinStreak || 0);
    const winnerPrevBestStreak = Number(winnerUser?.stats?.bestWinStreak || 0);

    const winnerNextWon = winnerPrevWon + 1;
    const winnerNextTotal = winnerPrevTotal + 1;
    const winnerNextCurrentStreak = winnerPrevCurrentStreak + 1;
    const winnerNextBestStreak = Math.max(
      winnerPrevBestStreak,
      winnerNextCurrentStreak
    );
    const winnerNextWinRate = winnerNextTotal > 0
      ? (winnerNextWon * 100) / winnerNextTotal
      : 0;

    const loserPrevWon = Number(loserUser?.stats?.gamesWon || 0);
    const loserPrevLost = Number(loserUser?.stats?.gamesLost || 0);
    const loserPrevDraw = Number(loserUser?.stats?.gamesDrawn || 0);
    const loserPrevTotal = Number(
      loserUser?.stats?.totalMatches ||
      loserPrevWon + loserPrevLost + loserPrevDraw
    );
    const loserNextLost = loserPrevLost + 1;
    const loserNextTotal = loserPrevTotal + 1;
    const loserNextWinRate = loserNextTotal > 0
      ? (loserPrevWon * 100) / loserNextTotal
      : 0;

    const monthIndex = new Date().getMonth();
    const winnerYearToDate = normalizeYearToDateArray(
      winnerUser?.earnings?.yearToDate
    );
    winnerYearToDate[monthIndex] = Math.max(
      0,
      asNumber(winnerYearToDate[monthIndex], 0) + payoutAmount
    );

    const winnerPrevTotalEarnings = asNumber(
      winnerUser?.earnings?.total ??
        winnerUser?.earnings?.career ??
        winnerUser?.stats?.totalWinnings,
      0
    );
    const winnerNextTotalEarnings = winnerPrevTotalEarnings + payoutAmount;

    const winnerUpdate = {
      $inc: {
        "earnings.availableBalance": payoutAmount,
        "earnings.career": payoutAmount,
        "stats.totalWinnings": payoutAmount,
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
      },
    };

    const loserUpdate = {
      $inc: {
        "stats.gamesLost": 1,
        "stats.totalMatches": 1,
        "stats.score": LOSER_SCORE_BONUS,
      },
      $set: {
        "stats.currentWinStreak": 0,
        "stats.winRate": Math.max(0, Math.min(100, loserNextWinRate)),
      },
    };

    await User.findByIdAndUpdate(winnerId, winnerUpdate, { session });
    await User.findByIdAndUpdate(loserId, loserUpdate, { session });

    if (payoutAmount > 0) {
      await Transaction.create(
        [
          {
            user: winnerId,
            amount: payoutAmount,
            type: "payout",
            status: "completed",
            meta: { matchId: match._id, commission: appCommission },
          },
        ],
        { session }
      );
    }

    if (appCommission > 0) {
      await Transaction.create(
        [
          {
            user: winnerId,
            amount: appCommission,
            type: "debit",
            status: "completed",
            meta: { matchId: match._id, description: "App Commission" },
          },
        ],
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    return res.json({
      message: "Match finished and funds settled successfully",
      match,
      payout: payoutAmount,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Match Settlement Failed:", error);

    return res.status(500).json({
      message: "Match settlement failed. Funds safe. Error: " + error.message,
    });
  }
}

// ========================
// 4. CANCEL MATCH
// ========================
export async function cancelMatch(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const actorId = toId(req.userId);
    const { matchId } = req.body;

    if (!actorId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!matchId || !mongoose.Types.ObjectId.isValid(matchId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Valid matchId is required" });
    }

    const match = await Match.findById(matchId).session(session);

    if (!match) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Match not found" });
    }

    if (!includesPlayer(match.players, actorId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Only a participant can cancel this match" });
    }

    if (match.status === "finished") {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({ message: "Finished matches cannot be cancelled" });
    }

    if (match.status === "cancelled") {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({ message: "Match is already cancelled" });
    }

    const wasPending = match.status === "pending";

    match.status = "cancelled";
    await match.save({ session });

    if (wasPending) {
      await User.findByIdAndUpdate(
        actorId,
        {
          $inc: {
            "stats.declinedChallenges": 1,
            "stats.matchesRefused": 1,
          },
        },
        { session }
      );
    }

    const entryFee = Math.max(0, Number(match.entryFee || 0));

    if (entryFee > 0) {
      for (const playerId of match.players) {
        await User.findByIdAndUpdate(
          playerId,
          {
            $inc: { "earnings.availableBalance": entryFee },
          },
          { session }
        );

        await Transaction.create(
          [
            {
              user: playerId,
              amount: entryFee,
              type: "refund",
              status: "completed",
              meta: { matchId: match._id, description: "Match Cancelled Refund" },
            },
          ],
          { session }
        );
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res.json({ message: "Match cancelled and funds refunded", match });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    return res.status(500).json({
      message: "Match cancellation failed. Error: " + error.message,
    });
  }
}
