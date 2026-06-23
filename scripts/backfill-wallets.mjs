// scripts/backfill-wallets.mjs
//
// U3 — one-time wallet backfill. For every user whose cached spendable balance
// (earnings.availableBalance) is AHEAD of their USER_WALLET ledger balance
// (status MATCH_WINNINGS_NOT_IN_LEDGER — past 1v1/tournament winnings that only
// credited the cache), post a single reconciling USER_WALLET credit so their
// ledger balance equals their true entitlement.
//
// Safety:
//   - DRY-RUN by default. Pass --apply to actually write.
//   - Aborts if ANY user is UNEXPLAINED (a negative balance) — the design's
//     go/no-go gate. Resolve those manually first.
//   - Idempotent: deterministic baseEntryId `MIGRATE_WALLET_<userId>` (the unique
//     index on entryId is the backstop) — re-running never double-credits.
//   - Reversible: entries tagged sourceType=MANUAL,
//     metadata.operation=WALLET_UNIFICATION_BACKFILL (queryable as a batch).
//   - Balanced: contra is SYSTEM_ADJUSTMENT (these funds already exist — they
//     were paid out as winnings; the ledger just never recorded them).
//
// Usage:  node scripts/backfill-wallets.mjs            (dry-run)
//         node scripts/backfill-wallets.mjs --apply    (write)
//
import "dotenv/config";
import mongoose from "mongoose";
import User from "../src/models/user.model.js";
import LedgerEntry from "../src/models/ledgerEntry.model.js";
import { creditUserWallet, syncAvailableBalanceCache, getUserWalletBalanceMinor } from "../src/services/ledgerUnification.service.js";
import {
  availableBalanceToMinor,
  classifyWalletDelta,
  summarizeReconciliation,
  isReconciliationSafeToBackfill,
} from "../src/utils/walletReconciliation.js";

const APPLY = process.argv.includes("--apply");
const CURRENCY = "GBP";
const OPERATION = "WALLET_UNIFICATION_BACKFILL";
const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const gbp = (minor) => `£${(Number(minor || 0) / 100).toFixed(2)}`;
const shortId = (id) => {
  const s = String(id || "");
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
};

await mongoose.connect(uri);
console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} wallet backfill on database: ${mongoose.connection.name}\n`);

try {
  const ledgerRows = await LedgerEntry.aggregate([
    { $match: { accountType: "USER_WALLET", currency: CURRENCY, status: "POSTED" } },
    {
      $group: {
        _id: "$accountId",
        debitMinor: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
        creditMinor: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
      },
    },
  ]);
  const ledgerByUser = new Map();
  for (const r of ledgerRows) ledgerByUser.set(String(r._id), Number(r.creditMinor || 0) - Number(r.debitMinor || 0));

  const users = await User.find({}, { username: 1, "earnings.availableBalance": 1 }).lean();
  const rows = users.map((u) => {
    const userId = String(u._id);
    const availableMinor = availableBalanceToMinor(u?.earnings?.availableBalance);
    const ledgerMinor = ledgerByUser.get(userId) || 0;
    const { status, deltaMinor } = classifyWalletDelta({ availableMinor, ledgerMinor });
    return { userId, username: String(u?.username || "").trim(), availableMinor, ledgerMinor, status, deltaMinor };
  });

  const summary = summarizeReconciliation(rows);
  if (!isReconciliationSafeToBackfill(summary)) {
    console.error(`ABORT: ${summary.byStatus.UNEXPLAINED} user(s) are UNEXPLAINED (negative balance). Resolve manually before backfilling.`);
    process.exit(1);
  }

  const candidates = rows.filter((r) => r.status === "MATCH_WINNINGS_NOT_IN_LEDGER" && r.deltaMinor > 0);
  console.log(`Candidates (cache ahead of ledger): ${candidates.length}`);
  console.log(`Total to credit into the ledger:    ${gbp(summary.backfillCreditMinor)}\n`);

  if (candidates.length === 0) {
    console.log("Nothing to backfill — all users already reconciled.");
  }

  let applied = 0;
  let skipped = 0;
  for (const c of candidates) {
    const who = c.username ? `${c.username} (${shortId(c.userId)})` : shortId(c.userId);
    const baseEntryId = `MIGRATE_WALLET_${c.userId}`;
    if (!APPLY) {
      console.log(`  would credit ${who}: ${gbp(c.deltaMinor)}  [entryId ${baseEntryId}_C]`);
      continue;
    }
    const res = await creditUserWallet({
      userId: c.userId,
      amountMinor: c.deltaMinor,
      contraAccountType: "SYSTEM_ADJUSTMENT",
      contraAccountId: "SYSTEM_MIGRATION",
      sourceType: "MANUAL",
      baseEntryId,
      currency: CURRENCY,
      metadata: { operation: OPERATION, classifiedDeltaMinor: c.deltaMinor },
    });
    await syncAvailableBalanceCache({ userId: c.userId, currency: CURRENCY });
    if (res.posted) applied += 1;
    else skipped += 1;
    const post = await getUserWalletBalanceMinor({ userId: c.userId, currency: CURRENCY });
    console.log(`  ${res.posted ? "credited" : "skipped (already)"} ${who}: ${gbp(c.deltaMinor)} → ledger now ${gbp(post)}`);
  }

  if (APPLY) {
    console.log(`\nDone. Applied ${applied}, skipped ${skipped} already-present.`);
  } else {
    console.log("\nDry-run only. Re-run with --apply to write these entries.");
  }
} catch (err) {
  console.error("Backfill failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
