import mongoose from "mongoose";
import DisputeCase from "../models/disputeCase.model.js";
import Match from "../models/match.model.js";
import LevelMatchSession from "../models/levelMatchSession.model.js";
import User from "../models/user.model.js";
import Transaction from "../models/transaction.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";

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

function disputeEnabled() {
  return boolFromEnv("FEATURE_DISPUTE_V2", false);
}

function matchCommissionRate() {
  const raw = Number(process.env.DISPUTE_MATCH_COMMISSION_RATE || 0.1);
  if (!Number.isFinite(raw)) return 0.1;
  return Math.max(0, Math.min(0.9, raw));
}

function requestUserId(req) {
  return cleanString(req.user?.id || req.user?._id || req.userId);
}

function requestClubId(req) {
  return cleanString(req.clubId || req.club?._id);
}

function toObjectId(v) {
  const id = cleanString(v);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function sameId(a, b) {
  return cleanString(a) === cleanString(b);
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function toMinor(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function toMajor(minor) {
  const n = Number(minor || 0);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function normalizeModule(v) {
  const m = upper(v, "MATCH");
  if (["MATCH", "LEVEL_MATCH", "TOURNAMENT", "SHOP", "OTHER"].includes(m)) return m;
  return "MATCH";
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "DISPUTE_DISABLED",
    message: "Dispute module is currently disabled.",
  });
}

function disputeResponse(row) {
  return {
    caseId: cleanString(row?.caseId),
    module: upper(row?.module || "OTHER"),
    moduleRefId: cleanString(row?.moduleRefId),
    openedByUserId: cleanString(row?.openedByUserId),
    respondentUserId: cleanString(row?.respondentUserId),
    organizerClubId: cleanString(row?.organizerClubId),
    status: upper(row?.status || "OPEN"),
    reason: cleanString(row?.reason),
    claimedAmountMinor: Number(row?.claimedAmountMinor || 0),
    currency: upper(row?.currency || "GBP"),
    evidence: Array.isArray(row?.evidence) ? row.evidence : [],
    comments: Array.isArray(row?.comments) ? row.comments : [],
    resolution: row?.resolution || {},
    metadata: row?.metadata || {},
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
  };
}

async function resolveDisputeTarget(module, moduleRefId, actorUserId) {
  if (module === "MATCH") {
    const mid = toObjectId(moduleRefId);
    if (!mid) {
      const err = new Error("Valid matchId is required");
      err.statusCode = 400;
      throw err;
    }
    const match = await Match.findById(mid).lean();
    if (!match) {
      const err = new Error("Match not found");
      err.statusCode = 404;
      throw err;
    }
    const players = Array.isArray(match.players) ? match.players.map((p) => cleanString(p)) : [];
    if (!players.some((p) => sameId(p, actorUserId))) {
      const err = new Error("Only match participants can open a dispute");
      err.statusCode = 403;
      throw err;
    }
    const respondentUserId = players.find((p) => !sameId(p, actorUserId)) || "";
    const entryFee = Math.max(0, Number(match.entryFee || 0));
    const totalWager = entryFee * 2;
    const appCommission = totalWager * matchCommissionRate();
    const payoutMajor = Math.max(0, totalWager - appCommission);
    const claimedAmountMinor = Math.max(0, Math.round(payoutMajor * 100));

    return {
      module: "MATCH",
      moduleRefId: cleanString(match._id),
      respondentUserId,
      organizerClubId: cleanString(match?.meta?.clubId || ""),
      claimedAmountMinor,
      currency: "GBP",
      metadata: {
        targetStatus: cleanString(match.status),
        winnerUserId: cleanString(match.winner),
        players,
        entryFee,
      },
    };
  }

  if (module === "LEVEL_MATCH") {
    const sessionId = upper(moduleRefId);
    if (!sessionId) {
      const err = new Error("Valid sessionId is required");
      err.statusCode = 400;
      throw err;
    }
    const row = await LevelMatchSession.findOne({ sessionId }).lean();
    if (!row) {
      const err = new Error("Level match not found");
      err.statusCode = 404;
      throw err;
    }
    const participants = Array.isArray(row.participants)
      ? row.participants.map((p) => cleanString(p))
      : [];
    if (!participants.some((p) => sameId(p, actorUserId))) {
      const err = new Error("Only level match participants can open a dispute");
      err.statusCode = 403;
      throw err;
    }
    const respondentUserId = participants.find((p) => !sameId(p, actorUserId)) || "";
    const claimedAmountMinor = toMinor(
      row.payoutMinor || Math.max(0, Number(row.totalPotMinor || 0) - Number(row.commissionMinor || 0))
    );
    const organizerClubId = cleanString(row?.metadata?.clubId || "");

    return {
      module: "LEVEL_MATCH",
      moduleRefId: sessionId,
      respondentUserId,
      organizerClubId,
      claimedAmountMinor,
      currency: upper(row.currency || "GBP"),
      metadata: {
        targetStatus: upper(row.status),
        winnerUserId: cleanString(row.winnerUserId),
        participants,
        level: Number(row.level || 1),
      },
    };
  }

  const err = new Error("Dispute module supports MATCH and LEVEL_MATCH currently");
  err.statusCode = 400;
  throw err;
}

async function userWalletMinorFromLedger({ userId, currency = "GBP", session = null }) {
  const agg = LedgerEntry.aggregate([
    {
      $match: {
        accountType: "USER_WALLET",
        accountId: cleanString(userId),
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
  if (session) agg.session(session);
  const rows = await agg;
  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

async function applyMatchPayoutImpact({ dispute, action, session }) {
  const matchId = toObjectId(dispute.moduleRefId);
  const match = await Match.findById(matchId).session(session);
  if (!match) {
    throw new Error("Match not found for payout adjustment");
  }
  if (upper(match.status) !== "FINISHED") {
    throw new Error("Only finished matches can be adjusted");
  }
  if (!match.winner) {
    throw new Error("Match winner is missing");
  }

  const players = Array.isArray(match.players) ? match.players.map((p) => cleanString(p)) : [];
  const winnerUserId = cleanString(match.winner);
  const loserUserId = players.find((p) => !sameId(p, winnerUserId));
  if (!loserUserId) throw new Error("Could not determine loser");

  const entryFee = Math.max(0, Number(match.entryFee || 0));
  const totalWager = entryFee * 2;
  const payoutMajor = Math.max(0, totalWager - totalWager * matchCommissionRate());
  let transferMajor = 0;
  if (action === "REVERSE_WINNER_TO_LOSER") transferMajor = payoutMajor;
  if (action === "SPLIT_POT") transferMajor = payoutMajor / 2;
  if (transferMajor <= 0) {
    return { payoutApplied: false, payoutAmountMinor: 0, notes: "No payout movement required" };
  }

  const [winner, loser] = await Promise.all([
    User.findById(winnerUserId).select("earnings stats").session(session),
    User.findById(loserUserId).select("earnings stats").session(session),
  ]);
  if (!winner || !loser) throw new Error("Users not found for payout adjustment");

  const winnerBalance = Number(winner?.earnings?.availableBalance || 0);
  if (winnerBalance < transferMajor) {
    const err = new Error("Winner wallet does not have enough balance for payout reversal");
    err.statusCode = 409;
    throw err;
  }

  const winnerWinnings = Number(winner?.stats?.totalWinnings || 0);
  const loserWinnings = Number(loser?.stats?.totalWinnings || 0);
  const winnerCareer = Number(winner?.earnings?.career || 0);
  const loserCareer = Number(loser?.earnings?.career || 0);
  const winnerTotal = Number(winner?.earnings?.total || 0);
  const loserTotal = Number(loser?.earnings?.total || 0);

  await User.findByIdAndUpdate(
    winnerUserId,
    {
      $set: {
        "earnings.availableBalance": Math.max(0, winnerBalance - transferMajor),
        "earnings.career": Math.max(0, winnerCareer - transferMajor),
        "earnings.total": Math.max(0, winnerTotal - transferMajor),
        "stats.totalWinnings": Math.max(0, winnerWinnings - transferMajor),
      },
    },
    { session }
  );

  await User.findByIdAndUpdate(
    loserUserId,
    {
      $set: {
        "earnings.availableBalance": Number(loser?.earnings?.availableBalance || 0) + transferMajor,
        "earnings.career": loserCareer + transferMajor,
        "earnings.total": loserTotal + transferMajor,
        "stats.totalWinnings": loserWinnings + transferMajor,
      },
    },
    { session }
  );

  await Transaction.create(
    [
      {
        user: winnerUserId,
        amount: transferMajor,
        type: "debit",
        status: "completed",
        meta: {
          disputeCaseId: dispute.caseId,
          module: "MATCH",
          moduleRefId: cleanString(match._id),
          action,
        },
      },
      {
        user: loserUserId,
        amount: transferMajor,
        type: "credit",
        status: "completed",
        meta: {
          disputeCaseId: dispute.caseId,
          module: "MATCH",
          moduleRefId: cleanString(match._id),
          action,
        },
      },
    ],
    { session }
  );

  if (action === "REVERSE_WINNER_TO_LOSER") {
    match.winner = loserUserId;
    await match.save({ session });
  }

  return {
    payoutApplied: true,
    payoutAmountMinor: Math.round(transferMajor * 100),
    notes: action === "REVERSE_WINNER_TO_LOSER" ? "Match winner payout reversed" : "Match payout split",
  };
}

async function applyLevelMatchPayoutImpact({ dispute, action, session }) {
  const row = await LevelMatchSession.findOne({ sessionId: upper(dispute.moduleRefId) }).session(session);
  if (!row) throw new Error("Level match not found for payout adjustment");
  if (upper(row.status) !== "SETTLED") throw new Error("Only settled level matches can be adjusted");

  const winnerUserId = cleanString(row.winnerUserId);
  const loserUserId = cleanString(row.loserUserId);
  if (!winnerUserId || !loserUserId) throw new Error("Level match winner/loser not found");

  const payoutMinor = toMinor(row.payoutMinor);
  let transferMinor = 0;
  if (action === "REVERSE_WINNER_TO_LOSER") transferMinor = payoutMinor;
  if (action === "SPLIT_POT") transferMinor = Math.floor(payoutMinor / 2);
  if (transferMinor <= 0) {
    return { payoutApplied: false, payoutAmountMinor: 0, notes: "No payout movement required" };
  }

  const ledgerBalance = await userWalletMinorFromLedger({
    userId: winnerUserId,
    currency: row.currency,
    session,
  });
  const winner = await User.findById(winnerUserId).select("earnings stats").session(session);
  const loser = await User.findById(loserUserId).select("earnings stats").session(session);
  if (!winner || !loser) throw new Error("Users not found for level payout adjustment");

  const fallbackWinnerMinor = Math.round(Number(winner?.earnings?.availableBalance || 0) * 100);
  const winnerWalletMinor = Math.max(ledgerBalance, fallbackWinnerMinor);
  if (winnerWalletMinor < transferMinor) {
    const err = new Error("Winner wallet does not have enough balance for level payout reversal");
    err.statusCode = 409;
    throw err;
  }

  const sourceId = upper(`DSP_${dispute.caseId}`);
  await LedgerEntry.insertMany(
    [
      {
        entryId: generatePublicId("LE"),
        intentId: null,
        direction: "DEBIT",
        accountType: "USER_WALLET",
        accountId: winnerUserId,
        amountMinor: transferMinor,
        currency: upper(row.currency || "GBP"),
        status: "POSTED",
        sourceType: "MANUAL",
        sourceId,
        metadata: {
          operation: "DISPUTE_PAYOUT_ADJUSTMENT",
          caseId: dispute.caseId,
          action,
          module: "LEVEL_MATCH",
          moduleRefId: cleanString(row.sessionId),
        },
      },
      {
        entryId: generatePublicId("LE"),
        intentId: null,
        direction: "CREDIT",
        accountType: "USER_WALLET",
        accountId: loserUserId,
        amountMinor: transferMinor,
        currency: upper(row.currency || "GBP"),
        status: "POSTED",
        sourceType: "MANUAL",
        sourceId,
        metadata: {
          operation: "DISPUTE_PAYOUT_ADJUSTMENT",
          caseId: dispute.caseId,
          action,
          module: "LEVEL_MATCH",
          moduleRefId: cleanString(row.sessionId),
        },
      },
    ],
    { session, ordered: true }
  );

  const transferMajor = toMajor(transferMinor);
  const winnerBalance = Number(winner?.earnings?.availableBalance || 0);
  const loserBalance = Number(loser?.earnings?.availableBalance || 0);
  const winnerWinnings = Number(winner?.stats?.totalWinnings || 0);
  const loserWinnings = Number(loser?.stats?.totalWinnings || 0);
  const winnerCareer = Number(winner?.earnings?.career || 0);
  const loserCareer = Number(loser?.earnings?.career || 0);
  const winnerTotal = Number(winner?.earnings?.total || 0);
  const loserTotal = Number(loser?.earnings?.total || 0);

  await User.findByIdAndUpdate(
    winnerUserId,
    {
      $set: {
        "earnings.availableBalance": Math.max(0, winnerBalance - transferMajor),
        "earnings.career": Math.max(0, winnerCareer - transferMajor),
        "earnings.total": Math.max(0, winnerTotal - transferMajor),
        "stats.totalWinnings": Math.max(0, winnerWinnings - transferMajor),
      },
    },
    { session }
  );
  await User.findByIdAndUpdate(
    loserUserId,
    {
      $set: {
        "earnings.availableBalance": loserBalance + transferMajor,
        "earnings.career": loserCareer + transferMajor,
        "earnings.total": loserTotal + transferMajor,
        "stats.totalWinnings": loserWinnings + transferMajor,
      },
    },
    { session }
  );

  await Transaction.create(
    [
      {
        user: winnerUserId,
        amount: transferMajor,
        type: "debit",
        status: "completed",
        meta: {
          disputeCaseId: dispute.caseId,
          module: "LEVEL_MATCH",
          moduleRefId: cleanString(row.sessionId),
          action,
        },
      },
      {
        user: loserUserId,
        amount: transferMajor,
        type: "credit",
        status: "completed",
        meta: {
          disputeCaseId: dispute.caseId,
          module: "LEVEL_MATCH",
          moduleRefId: cleanString(row.sessionId),
          action,
        },
      },
    ],
    { session }
  );

  if (action === "REVERSE_WINNER_TO_LOSER") {
    row.winnerUserId = loserUserId;
    row.loserUserId = winnerUserId;
    await row.save({ session });
  }

  return {
    payoutApplied: true,
    payoutAmountMinor: transferMinor,
    notes: action === "REVERSE_WINNER_TO_LOSER" ? "Level match payout reversed" : "Level match payout split",
  };
}

function defaultPayoutAction({ dispute, decision }) {
  const d = upper(decision, "NO_FAULT");
  if (d === "NO_FAULT" || d === "UPHOLD_RESPONDENT") return "NO_CHANGE";
  if (d === "SPLIT") return "SPLIT_POT";
  if (d === "UPHOLD_OPENER") {
    const winnerUserId = cleanString(dispute?.metadata?.winnerUserId);
    const openedBy = cleanString(dispute?.openedByUserId);
    if (winnerUserId && openedBy && winnerUserId !== openedBy) return "REVERSE_WINNER_TO_LOSER";
    return "NO_CHANGE";
  }
  return "NO_CHANGE";
}

function ensureCanViewDispute(req, dispute) {
  const userId = requestUserId(req);
  const clubId = requestClubId(req);
  const isParticipant =
    (userId && sameId(dispute.openedByUserId, userId)) ||
    (userId && sameId(dispute.respondentUserId, userId));
  const isOrganizer = clubId && sameId(dispute.organizerClubId, clubId);
  return !!isParticipant || !!isOrganizer;
}

function parseEvidence(items = [], actorUserId = null) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      type: upper(item?.type || "TEXT"),
      url: cleanString(item?.url),
      note: cleanString(item?.note),
      uploadedByUserId: actorUserId || null,
      uploadedAt: new Date(),
    }))
    .filter((row) => row.url || row.note);
}

export async function createDisputeCase(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const module = normalizeModule(req.body?.module);
    const moduleRefId = cleanString(req.body?.moduleRefId);
    const reason = cleanString(req.body?.reason);
    if (!moduleRefId) return res.status(400).json({ ok: false, message: "moduleRefId is required" });
    if (!reason) return res.status(400).json({ ok: false, message: "reason is required" });

    const active = await DisputeCase.findOne({
      module,
      moduleRefId: module === "LEVEL_MATCH" ? upper(moduleRefId) : moduleRefId,
      status: { $in: ["OPEN", "IN_REVIEW", "ESCALATED"] },
    }).lean();
    if (active) {
      return res.status(409).json({
        ok: false,
        code: "ACTIVE_DISPUTE_EXISTS",
        message: "An active dispute already exists for this item.",
        dispute: disputeResponse(active),
      });
    }

    const target = await resolveDisputeTarget(module, moduleRefId, userId);
    const caseId = generatePublicId("DSP");
    const evidence = parseEvidence(req.body?.evidence, toObjectId(userId));

    const row = await DisputeCase.create({
      caseId,
      module: target.module,
      moduleRefId: target.moduleRefId,
      openedByUserId: userId,
      respondentUserId: toObjectId(target.respondentUserId),
      organizerClubId: toObjectId(target.organizerClubId),
      status: target.organizerClubId ? "IN_REVIEW" : "OPEN",
      reason,
      claimedAmountMinor: Number(target.claimedAmountMinor || 0),
      currency: upper(target.currency || "GBP"),
      evidence,
      comments: [
        {
          actorType: "USER",
          actorUserId: toObjectId(userId),
          message: reason,
          stance: "OPENED",
          createdAt: new Date(),
        },
      ],
      metadata: target.metadata || {},
    });

    const userIdsToUpdate = [toObjectId(userId), toObjectId(target.respondentUserId)].filter(Boolean);
    if (userIdsToUpdate.length > 0) {
      await User.updateMany(
        { _id: { $in: userIdsToUpdate } },
        { $inc: { "stats.disputeHistoryCount": 1 } }
      );
    }

    return res.status(201).json({
      ok: true,
      message: "Dispute case created successfully.",
      dispute: disputeResponse(row),
    });
  } catch (e) {
    return res.status(e?.statusCode || 500).json({ ok: false, message: e.message || "Failed to create dispute" });
  }
}

export async function myDisputeCases(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const status = upper(req.query.status || "");
    const filter = {
      $or: [{ openedByUserId: toObjectId(userId) }, { respondentUserId: toObjectId(userId) }],
    };
    if (status) {
      const list = status
        .split(",")
        .map((x) => upper(x))
        .filter(Boolean);
      if (list.length > 0) filter.status = { $in: list };
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const rows = await DisputeCase.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

    return res.json({
      ok: true,
      disputes: rows.map(disputeResponse),
      meta: { count: rows.length, limit, serverTimeMs: Date.now() },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load disputes" });
  }
}

export async function organizerDisputeCases(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const clubId = requestClubId(req);
    if (!clubId) return res.status(401).json({ ok: false, message: "Unauthorized organizer" });

    const status = upper(req.query.status || "");
    const filter = { organizerClubId: toObjectId(clubId) };
    if (status) {
      const list = status
        .split(",")
        .map((x) => upper(x))
        .filter(Boolean);
      if (list.length > 0) filter.status = { $in: list };
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const rows = await DisputeCase.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({
      ok: true,
      disputes: rows.map(disputeResponse),
      meta: { count: rows.length, limit, serverTimeMs: Date.now() },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load organizer disputes" });
  }
}

export async function getDisputeCase(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const caseId = upper(req.params.caseId);
    const row = await DisputeCase.findOne({ caseId }).lean();
    if (!row) return res.status(404).json({ ok: false, message: "Dispute case not found" });
    if (!ensureCanViewDispute(req, row)) {
      return res.status(403).json({ ok: false, message: "Not allowed to view this dispute" });
    }
    return res.json({ ok: true, dispute: disputeResponse(row) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load dispute" });
  }
}

export async function commentOnDispute(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });
    const caseId = upper(req.params.caseId);
    const message = cleanString(req.body?.message);
    const stance = upper(req.body?.stance || "COMMENT");
    if (!message) return res.status(400).json({ ok: false, message: "message is required" });

    const row = await DisputeCase.findOne({ caseId });
    if (!row) return res.status(404).json({ ok: false, message: "Dispute case not found" });
    if (!ensureCanViewDispute(req, row)) {
      return res.status(403).json({ ok: false, message: "Not allowed to comment on this dispute" });
    }
    if (["RESOLVED", "REJECTED", "CANCELLED"].includes(upper(row.status))) {
      return res.status(409).json({ ok: false, message: "Dispute is already closed" });
    }

    row.comments = Array.isArray(row.comments) ? row.comments : [];
    row.comments.push({
      actorType: "USER",
      actorUserId: toObjectId(userId),
      message,
      stance,
      createdAt: new Date(),
    });
    const evidence = parseEvidence(req.body?.evidence, toObjectId(userId));
    if (evidence.length > 0) {
      row.evidence = [...(Array.isArray(row.evidence) ? row.evidence : []), ...evidence];
    }
    if (upper(row.status) === "OPEN") row.status = "IN_REVIEW";
    await row.save();

    return res.json({
      ok: true,
      message: "Comment added to dispute.",
      dispute: disputeResponse(row),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to add dispute comment" });
  }
}

export async function escalateDispute(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  try {
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });
    const caseId = upper(req.params.caseId);
    const note = cleanString(req.body?.note || "Escalated by participant");

    const row = await DisputeCase.findOne({ caseId });
    if (!row) return res.status(404).json({ ok: false, message: "Dispute case not found" });
    const isParticipant =
      sameId(row.openedByUserId, userId) || sameId(row.respondentUserId, userId);
    if (!isParticipant) {
      return res.status(403).json({ ok: false, message: "Only participants can escalate this dispute" });
    }
    if (["RESOLVED", "REJECTED", "CANCELLED"].includes(upper(row.status))) {
      return res.status(409).json({ ok: false, message: "Dispute is already closed" });
    }

    row.status = "ESCALATED";
    row.comments = Array.isArray(row.comments) ? row.comments : [];
    row.comments.push({
      actorType: "USER",
      actorUserId: toObjectId(userId),
      message: note,
      stance: "ESCALATED",
      createdAt: new Date(),
    });
    await row.save();
    return res.json({ ok: true, message: "Dispute escalated.", dispute: disputeResponse(row) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to escalate dispute" });
  }
}

async function resolveDisputeInternal(req, res, { actorType = "USER" } = {}) {
  const caseId = upper(req.params.caseId);
  const row = await DisputeCase.findOne({ caseId });
  if (!row) return res.status(404).json({ ok: false, message: "Dispute case not found" });

  if (["RESOLVED", "REJECTED", "CANCELLED"].includes(upper(row.status))) {
    return res.status(409).json({ ok: false, message: "Dispute is already closed" });
  }

  if (actorType === "ORGANIZER") {
    const clubId = requestClubId(req);
    if (!clubId || !sameId(row.organizerClubId, clubId)) {
      return res.status(403).json({ ok: false, message: "Only assigned organizer can resolve this dispute" });
    }
  } else {
    const userId = requestUserId(req);
    const isParticipant = sameId(row.openedByUserId, userId) || sameId(row.respondentUserId, userId);
    if (!isParticipant) {
      return res.status(403).json({ ok: false, message: "Only participants can resolve this dispute" });
    }
    if (row.organizerClubId && upper(row.status) !== "ESCALATED") {
      return res.status(409).json({
        ok: false,
        message: "Assigned organizer should resolve first. You can resolve after escalation.",
      });
    }
  }

  const decision = upper(req.body?.decision || "NO_FAULT");
  const payoutAction = upper(
    req.body?.payoutAction || defaultPayoutAction({ dispute: row, decision })
  );
  if (!["NO_FAULT", "UPHOLD_OPENER", "UPHOLD_RESPONDENT", "SPLIT"].includes(decision)) {
    return res.status(400).json({ ok: false, message: "Invalid decision" });
  }
  if (!["NO_CHANGE", "REVERSE_WINNER_TO_LOSER", "SPLIT_POT"].includes(payoutAction)) {
    return res.status(400).json({ ok: false, message: "Invalid payoutAction" });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const locked = await DisputeCase.findOne({ caseId }).session(session);
    if (!locked) throw new Error("Dispute case not found");
    if (["RESOLVED", "REJECTED", "CANCELLED"].includes(upper(locked.status))) {
      await session.commitTransaction();
      session.endSession();
      return res.json({ ok: true, reused: true, dispute: disputeResponse(locked) });
    }

    let payoutResult = { payoutApplied: false, payoutAmountMinor: 0, notes: "No payout impact applied" };
    if (payoutAction !== "NO_CHANGE") {
      if (upper(locked.module) === "MATCH") {
        payoutResult = await applyMatchPayoutImpact({ dispute: locked, action: payoutAction, session });
      } else if (upper(locked.module) === "LEVEL_MATCH") {
        payoutResult = await applyLevelMatchPayoutImpact({ dispute: locked, action: payoutAction, session });
      }
    }

    const userId = requestUserId(req);
    const clubId = requestClubId(req);
    locked.resolution = {
      decidedByType: actorType,
      decidedByUserId: actorType === "USER" ? toObjectId(userId) : null,
      decidedByClubId: actorType === "ORGANIZER" ? toObjectId(clubId) : null,
      decision,
      payoutAction,
      payoutAmountMinor: toMinor(payoutResult.payoutAmountMinor),
      currency: upper(locked.currency || "GBP"),
      payoutApplied: !!payoutResult.payoutApplied,
      payoutAppliedAt: payoutResult.payoutApplied ? new Date() : null,
      notes: cleanString(req.body?.notes || payoutResult.notes),
      resolvedAt: new Date(),
    };
    locked.status = decision === "UPHOLD_RESPONDENT" ? "REJECTED" : "RESOLVED";
    locked.comments = Array.isArray(locked.comments) ? locked.comments : [];
    locked.comments.push({
      actorType,
      actorUserId: actorType === "USER" ? toObjectId(userId) : null,
      actorClubId: actorType === "ORGANIZER" ? toObjectId(clubId) : null,
      message: cleanString(req.body?.notes || "Dispute resolved"),
      stance: decision,
      createdAt: new Date(),
    });
    await locked.save({ session });

    const winnerUserId =
      decision === "UPHOLD_OPENER"
        ? cleanString(locked.openedByUserId)
        : decision === "UPHOLD_RESPONDENT"
        ? cleanString(locked.respondentUserId)
        : "";
    if (winnerUserId) {
      await User.findByIdAndUpdate(
        winnerUserId,
        { $inc: { "stats.disputesWon": 1, "stats.disputeWins": 1 } },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();
    return res.json({
      ok: true,
      message: "Dispute resolved successfully.",
      dispute: disputeResponse(locked),
    });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(e?.statusCode || 500).json({
      ok: false,
      message: e.message || "Failed to resolve dispute",
    });
  }
}

export async function resolveDisputeAsUser(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  return resolveDisputeInternal(req, res, { actorType: "USER" });
}

export async function resolveDisputeAsOrganizer(req, res) {
  if (!disputeEnabled()) return serviceUnavailable(res);
  return resolveDisputeInternal(req, res, { actorType: "ORGANIZER" });
}
