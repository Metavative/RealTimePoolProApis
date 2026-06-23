// src/services/ledgerUnification.service.js
//
// U1 + U2 of the ledger↔earnings unification
// (see docs/PHASE_C_LEDGER_EARNINGS_UNIFICATION.md).
//
// Single place for:
//   - the FEATURE_LEDGER_UNIFIED flag (default OFF — nothing changes in prod
//     until it is flipped),
//   - reading a user's authoritative spendable balance from the USER_WALLET
//     ledger (U1),
//   - posting an idempotent, balanced USER_WALLET credit when a spendable amount
//     is granted (U2).
//
// Self-contained on purpose: it does NOT import from the controllers, so wiring
// it into matchController / tournamentPayout can't create circular imports, and
// the existing ledger-posting code is left untouched.

import LedgerEntry from "../models/ledgerEntry.model.js";
import User from "../models/user.model.js";

const VALID_ACCOUNT_TYPES = new Set([
  "USER_WALLET",
  "ORGANIZER_BALANCE",
  "PLATFORM_REVENUE",
  "PRIZE_POOL",
  "REFERRAL_COMMISSION",
  "HOLD_BALANCE",
  "SYSTEM_ADJUSTMENT",
]);

function clean(v) {
  return String(v ?? "").trim();
}
function upper(v, fallback = "") {
  return clean(v || fallback).toUpperCase();
}
function normalizeAccountType(v) {
  const t = upper(v);
  return VALID_ACCOUNT_TYPES.has(t) ? t : "";
}

// Read the unification flag. Default OFF.
export function ledgerUnifiedEnabled() {
  return String(process.env.FEATURE_LEDGER_UNIFIED || "").toLowerCase() === "true";
}

// Authoritative USER_WALLET ledger balance for a user (minor units):
// Σ POSTED credits − Σ POSTED debits. Mirrors getLedgerAccountBalanceMinor in
// payments.controller.js. accountId is the bare userId.
export async function getUserWalletBalanceMinor({ userId, currency = "GBP", session = null } = {}) {
  const accountId = clean(userId);
  if (!accountId) return 0;

  const pipeline = [
    {
      $match: {
        accountType: "USER_WALLET",
        accountId,
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
  ];

  const rows = await LedgerEntry.aggregate(pipeline).session(session || undefined);
  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

// U1 — the single spendable-balance read. When the flag is ON the ledger is the
// sole source of truth. When OFF, behaviour is preserved: callers pass the legacy
// fallback (max(ledger, earnings cache)) so nothing changes until we flip.
export async function getSpendableBalanceMinor({
  userId,
  currency = "GBP",
  session = null,
  fallbackMinor = 0,
} = {}) {
  const ledgerMinor = await getUserWalletBalanceMinor({ userId, currency, session });
  if (ledgerUnifiedEnabled()) return ledgerMinor;
  return Math.max(ledgerMinor, Math.max(0, Math.floor(Number(fallbackMinor) || 0)));
}

// U2 — idempotently post a balanced 2-line batch crediting a user's USER_WALLET
// from a contra account. Deterministic entryIds (`<BASE>_C` / `<BASE>_D`) make
// re-runs no-ops: the unique index on entryId is the backstop, and we check first.
//
// Returns { posted, already, amountMinor }.
export async function creditUserWallet({
  userId,
  amountMinor,
  contraAccountType = "SYSTEM_ADJUSTMENT",
  contraAccountId = "SYSTEM",
  sourceType = "PAYOUT",
  baseEntryId,
  currency = "GBP",
  session = null,
  metadata = {},
} = {}) {
  const uid = clean(userId);
  const amt = Math.floor(Number(amountMinor) || 0);
  const contraType = normalizeAccountType(contraAccountType);
  const contraId = clean(contraAccountId) || "SYSTEM";
  const base = upper(baseEntryId);

  if (!uid || amt <= 0 || !contraType || !base) {
    throw new Error("creditUserWallet: invalid arguments");
  }

  const creditEntryId = `${base}_C`;
  const debitEntryId = `${base}_D`;

  // Idempotency: if the credit leg already exists, this batch was posted before.
  const existing = await LedgerEntry.findOne({ entryId: creditEntryId })
    .session(session || undefined)
    .lean();
  if (existing) {
    return { posted: false, already: true, amountMinor: amt };
  }

  const common = {
    currency: upper(currency, "GBP"),
    status: "POSTED",
    sourceType: upper(sourceType, "PAYOUT"),
    sourceId: base,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };

  const docs = [
    { entryId: creditEntryId, direction: "CREDIT", accountType: "USER_WALLET", accountId: uid, amountMinor: amt, ...common },
    { entryId: debitEntryId, direction: "DEBIT", accountType: contraType, accountId: contraId, amountMinor: amt, ...common },
  ];

  try {
    await LedgerEntry.insertMany(docs, session ? { session } : undefined);
    return { posted: true, already: false, amountMinor: amt };
  } catch (err) {
    // Unique-index race (entryId already taken) ⇒ treat as already-posted.
    if (err && (err.code === 11000 || err.code === 11001)) {
      return { posted: false, already: true, amountMinor: amt };
    }
    throw err;
  }
}

// U4 — keep earnings.availableBalance as a write-through projection of the
// USER_WALLET ledger balance (MAJOR units), so the existing Flutter client (which
// reads availableBalance) shows the correct, ledger-backed number. Only meaningful
// once the flag is on and U3 backfill has run; callers gate on ledgerUnifiedEnabled().
export async function syncAvailableBalanceCache({ userId, currency = "GBP", session = null } = {}) {
  const uid = clean(userId);
  if (!uid) return 0;
  const ledgerMinor = await getUserWalletBalanceMinor({ userId: uid, currency, session });
  const major = Math.round(ledgerMinor) / 100;
  await User.updateOne(
    { _id: uid },
    { $set: { "earnings.availableBalance": major } },
    session ? { session } : undefined
  );
  return major;
}
