// utils/ledgerSummary.js
//
// Phase D: pure transforms over the result of a ledger aggregation grouped by
// accountType. Kept pure (no DB) so dashboard math is unit-testable; the
// controllers run the aggregation and pass the rows in.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// rows: [{ _id: <accountType>, debitMinor, creditMinor }]
// -> { <ACCOUNT_TYPE>: { debitMinor, creditMinor, balanceMinor } }
export function summarizeLedgerByAccountType(rows = []) {
  const byType = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const type = String(r?._id || "UNKNOWN").toUpperCase();
    const debitMinor = num(r?.debitMinor);
    const creditMinor = num(r?.creditMinor);
    byType[type] = { debitMinor, creditMinor, balanceMinor: creditMinor - debitMinor };
  }
  return byType;
}

// Headline platform money figures derived from the per-account-type summary.
// A positive balance on a CREDIT-natured account = money owed/held by that pool.
export function platformFinanceFromLedger(byType = {}) {
  const bal = (t) => num(byType?.[t]?.balanceMinor);
  return {
    platformRevenueMinor: bal("PLATFORM_REVENUE"),
    prizePoolHeldMinor: bal("PRIZE_POOL"),
    organizerBalancesMinor: bal("ORGANIZER_BALANCE"),
    userWalletsMinor: bal("USER_WALLET"),
    referralOwedMinor: bal("REFERRAL_COMMISSION"),
    holdBalanceMinor: bal("HOLD_BALANCE"),
  };
}

// Generic "[{ _id, count }]" -> { <KEY>: count, ...total } reducer for the
// status-breakdown aggregations (tournaments/disputes by status).
export function countByKey(rows = [], { upperKeys = true } = {}) {
  const out = {};
  let total = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    let key = String(r?._id ?? "UNKNOWN");
    if (upperKeys) key = key.toUpperCase();
    const c = num(r?.count);
    out[key] = c;
    total += c;
  }
  return { byStatus: out, total };
}

export default {
  summarizeLedgerByAccountType,
  platformFinanceFromLedger,
  countByKey,
};
