import mongoose from "mongoose";
import LedgerEntry from "../models/ledgerEntry.model.js";
import ReferralCommission from "../models/referralCommission.model.js";
import Transaction from "../models/transaction.model.js";
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

function referralCommissionBps() {
  const raw = Number(process.env.REFERRAL_COMMISSION_BPS || 5000);
  if (!Number.isFinite(raw)) return 5000;
  return Math.max(0, Math.min(10000, Math.floor(raw)));
}

function referralMinPayoutMinor() {
  const raw = Number(process.env.REFERRAL_MIN_PAYOUT_MINOR || 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(1000, Math.floor(raw)));
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

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function isValidObjectId(v) {
  return mongoose.Types.ObjectId.isValid(cleanString(v));
}

function buildDedupeKey({ sourceModule, sourceRefId, referredUserId }) {
  return upper(`${sourceModule || "OTHER"}:${sourceRefId || "UNKNOWN"}:${referredUserId || ""}`);
}

async function postBalancedReferralLedger({
  session,
  commissionId,
  currency,
  referrerUserId,
  payoutMinor,
  sourceModule,
  sourceRefId,
}) {
  const lines = [
    {
      direction: "DEBIT",
      accountType: "PLATFORM_REVENUE",
      accountId: "PLATFORM_DEFAULT",
      amountMinor: payoutMinor,
    },
    {
      direction: "CREDIT",
      accountType: "USER_WALLET",
      accountId: cleanString(referrerUserId),
      amountMinor: payoutMinor,
    },
  ];

  const docs = lines.map((line) => ({
    entryId: generatePublicId("LE"),
    intentId: null,
    direction: upper(line.direction),
    accountType: upper(line.accountType),
    accountId: cleanString(line.accountId),
    amountMinor: toMinor(line.amountMinor),
    currency: upper(currency || "GBP"),
    status: "POSTED",
    sourceType: "REFERRAL",
    sourceId: upper(commissionId),
    metadata: {
      operation: "REFERRAL_COMMISSION_PAYOUT",
      sourceModule: upper(sourceModule || "OTHER"),
      sourceRefId: cleanString(sourceRefId),
    },
  }));

  const debitTotal = docs
    .filter((row) => row.direction === "DEBIT")
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const creditTotal = docs
    .filter((row) => row.direction === "CREDIT")
    .reduce((sum, row) => sum + row.amountMinor, 0);
  if (debitTotal <= 0 || creditTotal <= 0 || debitTotal !== creditTotal) {
    throw new Error("Referral ledger is not balanced");
  }

  await LedgerEntry.insertMany(docs, { session, ordered: true });
}

export async function postReferralCommission({
  referredUserId,
  sourceModule = "OTHER",
  sourceRefId = "",
  sourceCommissionMinor = 0,
  currency = "GBP",
  metadata = {},
}) {
  try {
    if (!referralEnabled()) {
      return { ok: true, applied: false, reason: "feature_disabled" };
    }

    if (!isValidObjectId(referredUserId)) {
      return { ok: true, applied: false, reason: "invalid_referred_user" };
    }

    const sourceMinor = toMinor(sourceCommissionMinor);
    if (sourceMinor <= 0) {
      return { ok: true, applied: false, reason: "source_commission_zero" };
    }

    const referred = await User.findById(referredUserId)
      .select("referral.referredByUserId referral.referredByCode")
      .lean();
    const referrerUserId = cleanString(referred?.referral?.referredByUserId);
    if (!referrerUserId || !isValidObjectId(referrerUserId)) {
      return { ok: true, applied: false, reason: "no_referrer_linked" };
    }
    if (cleanString(referrerUserId) === cleanString(referredUserId)) {
      return { ok: true, applied: false, reason: "self_referral_blocked" };
    }

    const bps = referralCommissionBps();
    const payoutMinor = Math.floor((sourceMinor * bps) / 10000);
    if (payoutMinor < referralMinPayoutMinor()) {
      return { ok: true, applied: false, reason: "below_min_payout" };
    }

    const dedupeKey = buildDedupeKey({
      sourceModule,
      sourceRefId,
      referredUserId,
    });

    const existing = await ReferralCommission.findOne({ dedupeKey }).lean();
    if (existing) {
      return {
        ok: true,
        applied: true,
        reused: true,
        commissionId: cleanString(existing.commissionId),
        payoutMinor: toMinor(existing.payoutMinor),
      };
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const commissionId = generatePublicId("RFC");
      const commissionRows = await ReferralCommission.create(
        [
          {
            commissionId,
            dedupeKey,
            sourceModule: upper(sourceModule || "OTHER"),
            sourceRefId: cleanString(sourceRefId),
            referrerUserId,
            referredUserId,
            currency: upper(currency || "GBP"),
            sourceCommissionMinor: sourceMinor,
            payoutMinor,
            status: "PENDING",
            metadata: metadata && typeof metadata === "object" ? metadata : {},
          },
        ],
        { session }
      );
      const commission = commissionRows[0];

      await postBalancedReferralLedger({
        session,
        commissionId,
        currency,
        referrerUserId,
        payoutMinor,
        sourceModule,
        sourceRefId,
      });

      const payoutMajor = toMajor(payoutMinor);
      await User.findByIdAndUpdate(
        referrerUserId,
        {
          $inc: {
            "earnings.availableBalance": payoutMajor,
            "earnings.career": payoutMajor,
            "earnings.total": payoutMajor,
            "referral.totalReferralEarnings": payoutMajor,
          },
        },
        { session }
      );

      await Transaction.create(
        [
          {
            user: referrerUserId,
            amount: payoutMajor,
            type: "credit",
            status: "completed",
            meta: {
              referralCommissionId: commissionId,
              sourceModule: upper(sourceModule || "OTHER"),
              sourceRefId: cleanString(sourceRefId),
              referredUserId: cleanString(referredUserId),
              payoutMinor,
            },
          },
        ],
        { session }
      );

      commission.status = "SETTLED";
      commission.paidAt = new Date();
      commission.ledgerSourceId = upper(commissionId);
      await commission.save({ session });

      await session.commitTransaction();
      session.endSession();

      return {
        ok: true,
        applied: true,
        reused: false,
        commissionId,
        payoutMinor,
      };
    } catch (inner) {
      await session.abortTransaction();
      session.endSession();
      throw inner;
    }
  } catch (e) {
    return {
      ok: false,
      applied: false,
      reason: "error",
      error: cleanString(e?.message || "Failed to post referral commission"),
    };
  }
}
