// src/utils/walletReconciliation.js
//
// U0 of the ledger↔earnings unification (see docs/PHASE_C_LEDGER_EARNINGS_UNIFICATION.md).
// Pure, side-effect-free helpers for comparing a user's cached spendable balance
// (`earnings.availableBalance`, stored in MAJOR units / pounds) against their
// authoritative `USER_WALLET` ledger balance (MINOR units / pence).
//
// These are unit-tested in test/run-tests.js. No DB access here — callers pass
// already-fetched numbers so the logic can be tested deterministically.

// `earnings.availableBalance` is stored in MAJOR units (pounds). The ledger is in
// MINOR units (pence). Convert major → minor with rounding to avoid float drift.
export function availableBalanceToMinor(availableMajor) {
  const n = Number(availableMajor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Classify the delta between the cached available balance and the ledger balance,
// both in MINOR units. `toleranceMinor` absorbs sub-penny rounding (default 0).
//
// Returns { status, deltaMinor } where deltaMinor = availableMinor - ledgerMinor:
//   IN_SYNC                      delta within tolerance
//   MATCH_WINNINGS_NOT_IN_LEDGER availableBalance ahead (1v1/tournament winnings
//                                that only credited the cache, never the ledger)
//   LEDGER_AHEAD                 ledger ahead (level/wallet money the cache missed)
//   UNEXPLAINED                  a negative balance on either side (impossible —
//                                needs manual review before any backfill)
export function classifyWalletDelta({
  availableMinor,
  ledgerMinor,
  toleranceMinor = 0,
}) {
  const a = Number(availableMinor) || 0;
  const l = Number(ledgerMinor) || 0;
  const deltaMinor = a - l;

  if (a < 0 || l < 0) {
    return { status: "UNEXPLAINED", deltaMinor };
  }
  if (Math.abs(deltaMinor) <= Math.abs(Number(toleranceMinor) || 0)) {
    return { status: "IN_SYNC", deltaMinor: 0 };
  }
  if (deltaMinor > 0) {
    return { status: "MATCH_WINNINGS_NOT_IN_LEDGER", deltaMinor };
  }
  return { status: "LEDGER_AHEAD", deltaMinor };
}

// Aggregate an array of per-user rows ({ status, deltaMinor, ... }) into totals.
// `absDeltaMinor` sums absolute deltas so opposite-sign rows don't cancel out and
// hide the true reconciliation gap.
export function summarizeReconciliation(rows = []) {
  const out = {
    users: 0,
    byStatus: {
      IN_SYNC: 0,
      MATCH_WINNINGS_NOT_IN_LEDGER: 0,
      LEDGER_AHEAD: 0,
      UNEXPLAINED: 0,
    },
    netDeltaMinor: 0,
    absDeltaMinor: 0,
    // The gap that a U3 backfill would need to credit into the ledger.
    backfillCreditMinor: 0,
  };

  for (const row of rows) {
    if (!row) continue;
    out.users += 1;
    const status = out.byStatus[row.status] === undefined ? "UNEXPLAINED" : row.status;
    out.byStatus[status] += 1;

    const d = Number(row.deltaMinor) || 0;
    out.netDeltaMinor += d;
    out.absDeltaMinor += Math.abs(d);
    if (status === "MATCH_WINNINGS_NOT_IN_LEDGER" && d > 0) {
      out.backfillCreditMinor += d;
    }
  }

  return out;
}

// Whether the report is clean enough to proceed to the U3 backfill: no
// UNEXPLAINED rows (the design's go/no-go gate).
export function isReconciliationSafeToBackfill(summary) {
  return Boolean(summary) && (summary.byStatus?.UNEXPLAINED || 0) === 0;
}
