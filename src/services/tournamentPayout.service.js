// services/tournamentPayout.service.js
//
// Phase B money sub-phase: tournament PRIZE DISTRIBUTION.
//
// Completes the gap found in the audit (tournament wins credited no earnings),
// which also completes the Phase A money leaderboard for tournament winners.
//
// Design / safety:
//   - Feature-gated by FEATURE_TOURNAMENT_PAYOUTS (default OFF). Money writes are
//     opt-in, mirroring the wallet-hardening posture.
//   - IDEMPOTENT: the `prizeSettlement.settled` flag is claimed atomically with a
//     compare-and-set BEFORE any credit, so the pool can never be paid twice —
//     even on concurrent calls or retries.
//   - Credits the SAME earnings fields, the SAME way, as 1v1 (matchController)
//     and level matches (levelEconomy): availableBalance + career + totalWinnings
//     are $inc'd and total is $set to prev+amount. This makes tournament winnings
//     behave identically to other winnings (ranking + withdrawability) and keeps
//     resolveMoneyEarned()'s max() invariant intact.
//   - The prize pool is computed from PAID entry orders' prizePoolMinor, so it
//     works in mock and real payment modes alike.

import Tournament from "../models/tournament.model.js";
import TournamentEntryOrder from "../models/tournamentEntryOrder.model.js";
import User from "../models/user.model.js";
import { drawDownTournamentPrizePool } from "../controllers/payments.controller.js";
import {
  ledgerUnifiedEnabled,
  creditUserWallet,
  syncAvailableBalanceCache,
} from "./ledgerUnification.service.js";

// PRIZE_POOL ledger sub-account for a tournament (matches tournamentEconomy).
function prizePoolAccountId(tournamentId) {
  return `PRIZE_TOURN_${String(tournamentId ?? "").trim()}`;
}

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function tournamentPayoutsEnabled() {
  return envFlag("FEATURE_TOURNAMENT_PAYOUTS", false);
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Sum of prize-pool minor units across PAID entry orders. Pure + exported.
export function computePrizePoolMinor(orders = []) {
  let total = 0;
  for (const o of orders) {
    if (String(o?.status || "").toUpperCase() !== "PAID") continue;
    total += Math.max(0, num(o?.prizePoolMinor, 0));
  }
  return total;
}

// Resolve ordered prize winners from a tournament. MVP: champion only.
// Returns [{ participantKey, userId, placement, isLocal }]. A winner whose
// entrant is local / has no user account has userId="" (not payable).
// Pure + exported.
export function resolvePrizeWinners(tournament = {}, maxWinners = 1) {
  const championKey = String(tournament?.championName || "").trim();
  if (!championKey) return [];

  const entrants = Array.isArray(tournament?.entrants) ? tournament.entrants : [];
  const byKey = new Map(
    entrants.map((e) => [String(e?.participantKey || "").trim(), e])
  );

  const order = [championKey]; // MVP: single champion. (Runner-up: future.)
  const winners = [];
  for (let i = 0; i < order.length && winners.length < maxWinners; i++) {
    const key = order[i];
    const e = byKey.get(key);
    const userId = e ? String(e.entrantId || e.userId || "").trim() : "";
    winners.push({
      participantKey: key,
      userId: e?.isLocal ? "" : userId,
      placement: i + 1,
      isLocal: !!e?.isLocal || !userId,
    });
  }
  return winners;
}

// Split a pool across winners by basis points (default: 100% to 1st). The first
// payable winner absorbs any rounding remainder. Pure + exported.
export function computePayouts(poolMinor, winners = [], splitBps = [10000]) {
  const pool = Math.max(0, Math.floor(num(poolMinor, 0)));
  const payable = winners.filter((w) => w.userId);
  if (pool <= 0 || payable.length === 0) return [];

  let allocated = 0;
  const payouts = payable.map((w, i) => {
    const bps = num(splitBps[i], i === 0 ? 10000 : 0);
    const amt = Math.floor((pool * bps) / 10000);
    allocated += amt;
    return { ...w, amountMinor: amt };
  });

  // Give any rounding remainder (or unallocated bps) to first place.
  const remainder = pool - allocated;
  if (remainder > 0 && payouts.length > 0) {
    payouts[0].amountMinor += remainder;
  }
  return payouts;
}

// Credit a single winner's earnings exactly like match/level payouts do.
async function creditWinnerEarnings(userId, amountMinor) {
  if (!userId || amountMinor <= 0) return false;
  const u = await User.findById(userId)
    .select("earnings.total earnings.career stats.totalWinnings")
    .lean();
  if (!u) return false;
  // earnings.* and the ranking trio (career/total/totalWinnings) are stored in
  // MAJOR units (pounds) everywhere else — 1v1 (matchController `payoutAmount`),
  // level matches (`*Major`), referral (`payoutMajor`). This site previously
  // wrote the MINOR amount, a 100× over-credit that inflated both spendable
  // balance and ranking. Convert to major to match the rest of the system.
  const amountMajor = amountMinor / 100;
  const prevTotal = num(
    u?.earnings?.total ?? u?.earnings?.career ?? u?.stats?.totalWinnings,
    0
  );
  await User.findByIdAndUpdate(userId, {
    $inc: {
      "earnings.availableBalance": amountMajor,
      "earnings.career": amountMajor,
      "stats.totalWinnings": amountMajor,
    },
    $set: { "earnings.total": prevTotal + amountMajor },
  });
  return true;
}

/**
 * Settle (distribute) a completed tournament's prize pool to its winner(s).
 *
 * @param {string} tournamentId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object>} result with { ok, code?, settlement? }
 */
export async function settleTournamentPrizes(tournamentId, opts = {}) {
  if (!tournamentPayoutsEnabled()) {
    return { ok: false, code: "PAYOUTS_DISABLED" };
  }

  const t = await Tournament.findById(tournamentId);
  if (!t) return { ok: false, code: "TOURNAMENT_NOT_FOUND" };

  if (String(t.status || "").toUpperCase() !== "COMPLETED") {
    return { ok: false, code: "TOURNAMENT_NOT_COMPLETED" };
  }
  if (!t?.economy?.enabled) {
    return { ok: false, code: "ECONOMY_DISABLED" };
  }

  // Already settled? Idempotent no-op.
  if (t?.prizeSettlement?.settled) {
    return { ok: true, alreadySettled: true, settlement: t.prizeSettlement };
  }

  const winners = resolvePrizeWinners(t, 1);
  const payableWinners = winners.filter((w) => w.userId);
  if (payableWinners.length === 0) {
    // Don't claim settlement — the champion may be unresolved/local; allow a
    // retry after the bracket is corrected.
    return {
      ok: false,
      code: "NO_PAYABLE_WINNER",
      message:
        "No payable winner could be resolved (champion missing or a non-user entrant).",
    };
  }

  const orders = await TournamentEntryOrder.find({
    tournamentId,
    status: "PAID",
  })
    .select("prizePoolMinor status")
    .lean();
  const poolMinor = computePrizePoolMinor(orders);
  if (poolMinor <= 0) {
    return { ok: false, code: "EMPTY_PRIZE_POOL" };
  }

  const currency = String(t?.economy?.currency || "GBP").toUpperCase();

  // Atomic claim: flip settled=false -> true only if not already settled. This
  // is the single guard that makes double-payout impossible under concurrency.
  const claimed = await Tournament.findOneAndUpdate(
    { _id: tournamentId, "prizeSettlement.settled": { $ne: true } },
    { $set: { "prizeSettlement.settled": true, "prizeSettlement.settledAt": new Date() } },
    { new: true }
  );
  if (!claimed) {
    // Someone else just settled it.
    const fresh = await Tournament.findById(tournamentId).select("prizeSettlement").lean();
    return { ok: true, alreadySettled: true, settlement: fresh?.prizeSettlement };
  }

  const payouts = computePayouts(poolMinor, payableWinners, [10000]);

  const recorded = [];
  for (const p of payouts) {
    let credited = false;
    try {
      credited = await creditWinnerEarnings(p.userId, p.amountMinor);
    } catch (e) {
      console.error(
        `tournament payout credit failed for ${p.userId}:`,
        e?.message || e
      );
    }
    recorded.push({
      userId: p.userId,
      participantKey: p.participantKey,
      placement: p.placement,
      amountMinor: p.amountMinor,
      credited,
    });
  }

  const allCredited = recorded.every((r) => r.credited);

  let drawdown = null;
  let ledgerCredits = null;

  if (ledgerUnifiedEnabled()) {
    // U2 (ledger unification): the prize lands as spendable USER_WALLET ledger
    // money — DEBIT PRIZE_POOL(PRIZE_TOURN_<id>) → CREDIT USER_WALLET(winner).
    // This supersedes the C2 gateway-out drawdown when unification is on. The
    // earnings.availableBalance credit above is then the synced cache. Idempotent
    // per winner via deterministic entryId.
    ledgerCredits = [];
    for (const r of recorded) {
      if (!r.credited || !(num(r.amountMinor, 0) > 0)) continue;
      try {
        const res = await creditUserWallet({
          userId: r.userId,
          amountMinor: num(r.amountMinor, 0),
          contraAccountType: "PRIZE_POOL",
          contraAccountId: prizePoolAccountId(tournamentId),
          sourceType: "SETTLEMENT",
          baseEntryId: `TPRIZE_${tournamentId}_${r.userId}`,
          currency,
          metadata: { tournamentId: String(tournamentId), placement: r.placement },
        });
        ledgerCredits.push({ userId: r.userId, ...res });
        // U4: keep the availableBalance cache equal to the ledger projection.
        await syncAvailableBalanceCache({ userId: r.userId, currency });
      } catch (e) {
        console.error(
          `tournament wallet ledger credit failed for ${r.userId}:`,
          e?.message || e
        );
      }
    }
  } else {
    // Phase C2 (legacy): draw down the prize-pool ledger account for the amount
    // actually paid, so PRIZE_TOURN_<id> doesn't keep a phantom balance.
    // Best-effort + idempotent — a failure must not undo the claimed settlement.
    const totalCredited = recorded
      .filter((r) => r.credited)
      .reduce((a, r) => a + Math.max(0, num(r.amountMinor, 0)), 0);
    try {
      drawdown = await drawDownTournamentPrizePool({
        tournamentId,
        amountMinor: totalCredited,
        currency,
        trigger: "tournament_prize_settlement",
      });
    } catch (e) {
      console.error("Prize-pool ledger drawdown failed:", e?.message || e);
    }
  }

  await Tournament.updateOne(
    { _id: tournamentId },
    {
      $set: {
        "prizeSettlement.totalMinor": poolMinor,
        "prizeSettlement.currency": currency,
        "prizeSettlement.payouts": recorded,
        "prizeSettlement.note": allCredited
          ? "Prizes distributed."
          : "Partial: some credits failed — reconcile manually.",
      },
    }
  );

  return {
    ok: true,
    settled: true,
    totalMinor: poolMinor,
    currency,
    payouts: recorded,
    allCredited,
    drawdown,
    ledgerCredits,
  };
}

export default {
  tournamentPayoutsEnabled,
  computePrizePoolMinor,
  resolvePrizeWinners,
  computePayouts,
  settleTournamentPrizes,
};
