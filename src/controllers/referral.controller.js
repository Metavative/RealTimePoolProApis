import mongoose from "mongoose";
import ReferralCommission from "../models/referralCommission.model.js";
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

function referralEnabled() {
  return boolFromEnv("FEATURE_REFERRAL_V2", false);
}

function requestUserId(req) {
  return req.user?.id || req.user?._id || req.userId || null;
}

function toId(v) {
  return cleanString(v?.toString?.() || v);
}

function isValidObjectId(v) {
  return mongoose.Types.ObjectId.isValid(toId(v));
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "REFERRAL_DISABLED",
    message: "Referral module is currently disabled.",
  });
}

function userDisplayName(user) {
  const nickname = cleanString(user?.profile?.nickname);
  if (nickname) return nickname;
  const username = cleanString(user?.username);
  if (username) return username;
  return "Player";
}

function myReferralCode(user) {
  const tag = cleanString(user?.stats?.userIdTag);
  if (tag) return upper(tag);
  const username = cleanString(user?.username);
  return upper(username);
}

function commissionResponse(row) {
  return {
    commissionId: cleanString(row?.commissionId),
    sourceModule: upper(row?.sourceModule || "OTHER"),
    sourceRefId: cleanString(row?.sourceRefId),
    referrerUserId: toId(row?.referrerUserId),
    referredUserId: toId(row?.referredUserId),
    currency: upper(row?.currency || "GBP"),
    sourceCommissionMinor: Number(row?.sourceCommissionMinor || 0),
    payoutMinor: Number(row?.payoutMinor || 0),
    status: upper(row?.status || "PENDING"),
    paidAt: row?.paidAt || null,
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
  };
}

export async function linkReferralCode(req, res) {
  if (!referralEnabled()) return serviceUnavailable(res);
  try {
    const userId = toId(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const code = upper(req.body?.referralCode || req.body?.code);
    if (!code) {
      return res.status(400).json({
        ok: false,
        message: "Referral code is required.",
      });
    }

    const me = await User.findById(userId)
      .select("username usernameLower profile.nickname stats.userIdTag referral")
      .lean();
    if (!me) return res.status(404).json({ ok: false, message: "User not found" });

    if (me?.referral?.referredByUserId) {
      return res.status(409).json({
        ok: false,
        code: "REFERRAL_ALREADY_LINKED",
        message: "Your referral is already linked.",
      });
    }

    const myCode = myReferralCode(me);
    if (myCode && myCode === code) {
      return res.status(400).json({
        ok: false,
        code: "SELF_REFERRAL_NOT_ALLOWED",
        message: "You cannot use your own referral code.",
      });
    }

    const referrer = await User.findOne({
      $or: [{ "stats.userIdTag": code }, { usernameLower: code.toLowerCase() }],
    })
      .select("username profile.nickname stats.userIdTag")
      .lean();

    if (!referrer) {
      return res.status(404).json({
        ok: false,
        code: "REFERRAL_CODE_NOT_FOUND",
        message: "Referral code not found.",
      });
    }

    if (!isValidObjectId(referrer?._id) || toId(referrer._id) === userId) {
      return res.status(400).json({
        ok: false,
        code: "SELF_REFERRAL_NOT_ALLOWED",
        message: "You cannot use your own referral code.",
      });
    }

    await User.findByIdAndUpdate(userId, {
      $set: {
        "referral.referredByUserId": referrer._id,
        "referral.referredByCode": upper(code),
        "referral.referredAt": new Date(),
      },
    });

    return res.json({
      ok: true,
      message: "Referral code linked successfully.",
      referral: {
        myCode,
        referredBy: {
          userId: toId(referrer._id),
          username: cleanString(referrer.username),
          displayName: userDisplayName(referrer),
          code: cleanString(referrer?.stats?.userIdTag).toUpperCase(),
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to link referral code" });
  }
}

export async function myReferralSummary(req, res) {
  if (!referralEnabled()) return serviceUnavailable(res);
  try {
    const userId = toId(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const me = await User.findById(userId)
      .select("username profile.nickname stats.userIdTag referral")
      .lean();
    if (!me) return res.status(404).json({ ok: false, message: "User not found" });

    const [referredUsersCount, settledAgg, pendingAgg, recent] = await Promise.all([
      User.countDocuments({ "referral.referredByUserId": me._id }),
      ReferralCommission.aggregate([
        { $match: { referrerUserId: me._id, status: "SETTLED" } },
        {
          $group: {
            _id: null,
            payoutMinor: { $sum: "$payoutMinor" },
            count: { $sum: 1 },
          },
        },
      ]),
      ReferralCommission.aggregate([
        { $match: { referrerUserId: me._id, status: { $in: ["PENDING"] } } },
        {
          $group: {
            _id: null,
            payoutMinor: { $sum: "$payoutMinor" },
            count: { $sum: 1 },
          },
        },
      ]),
      ReferralCommission.find({ referrerUserId: me._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    let referredBy = null;
    if (me?.referral?.referredByUserId) {
      const referrer = await User.findById(me.referral.referredByUserId)
        .select("username profile.nickname stats.userIdTag")
        .lean();
      if (referrer) {
        referredBy = {
          userId: toId(referrer._id),
          username: cleanString(referrer.username),
          displayName: userDisplayName(referrer),
          code: cleanString(referrer?.stats?.userIdTag).toUpperCase(),
        };
      }
    }

    const settled = settledAgg[0] || { payoutMinor: 0, count: 0 };
    const pending = pendingAgg[0] || { payoutMinor: 0, count: 0 };

    return res.json({
      ok: true,
      summary: {
        myCode: myReferralCode(me),
        referredUsersCount,
        referredBy,
        totalSettledCommissions: Number(settled.count || 0),
        totalSettledPayoutMinor: Number(settled.payoutMinor || 0),
        pendingCommissions: Number(pending.count || 0),
        pendingPayoutMinor: Number(pending.payoutMinor || 0),
      },
      recent: recent.map(commissionResponse),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load referral summary" });
  }
}

export async function myReferralHistory(req, res) {
  if (!referralEnabled()) return serviceUnavailable(res);
  try {
    const userId = toId(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const status = upper(req.query.status || "");
    const filter = { referrerUserId: new mongoose.Types.ObjectId(userId) };
    if (status) {
      const list = status
        .split(",")
        .map((x) => upper(x))
        .filter(Boolean);
      if (list.length > 0) filter.status = { $in: list };
    }

    const rows = await ReferralCommission.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const referredIds = Array.from(new Set(rows.map((r) => toId(r.referredUserId)).filter(Boolean)));
    const referredUsers = await User.find({ _id: { $in: referredIds } })
      .select("username profile.nickname")
      .lean();
    const rMap = new Map(referredUsers.map((u) => [toId(u._id), u]));

    return res.json({
      ok: true,
      history: rows.map((row) => {
        const referred = rMap.get(toId(row.referredUserId));
        return {
          ...commissionResponse(row),
          referredUser: referred
            ? {
                userId: toId(referred._id),
                username: cleanString(referred.username),
                displayName: userDisplayName(referred),
              }
            : null,
        };
      }),
      meta: {
        count: rows.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load referral history" });
  }
}
