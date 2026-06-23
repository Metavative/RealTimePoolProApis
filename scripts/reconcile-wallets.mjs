// scripts/reconcile-wallets.mjs
//
// U0 — READ-ONLY wallet reconciliation report. For every user, compares the
// cached spendable balance (earnings.availableBalance, MAJOR units) against the
// authoritative USER_WALLET ledger balance (MINOR units) and classifies the
// delta. Drives the U3 backfill and gives a go/no-go signal. Makes NO writes.
//
// Usage:  node scripts/reconcile-wallets.mjs
//
import "dotenv/config";
import { MongoClient } from "mongodb";
import {
  availableBalanceToMinor,
  classifyWalletDelta,
  summarizeReconciliation,
  isReconciliationSafeToBackfill,
} from "../src/utils/walletReconciliation.js";

const CURRENCY = "GBP";
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

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db();
  console.log(`Reconciling wallets in database: ${db.databaseName}\n`);

  // One pass: USER_WALLET ledger balance per user (accountId === bare userId).
  const ledgerRows = await db
    .collection("ledgerentries")
    .aggregate([
      { $match: { accountType: "USER_WALLET", currency: CURRENCY, status: "POSTED" } },
      {
        $group: {
          _id: "$accountId",
          debitMinor: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
          creditMinor: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
        },
      },
    ])
    .toArray();

  const ledgerByUser = new Map();
  for (const r of ledgerRows) {
    ledgerByUser.set(String(r._id), Number(r.creditMinor || 0) - Number(r.debitMinor || 0));
  }

  const users = await db
    .collection("users")
    .find({}, { projection: { username: 1, "earnings.availableBalance": 1 } })
    .toArray();

  const rows = users.map((u) => {
    const userId = String(u._id);
    const availableMinor = availableBalanceToMinor(u?.earnings?.availableBalance);
    const ledgerMinor = ledgerByUser.get(userId) || 0;
    const { status, deltaMinor } = classifyWalletDelta({ availableMinor, ledgerMinor });
    return {
      userId,
      username: String(u?.username || "").trim(),
      availableMinor,
      ledgerMinor,
      status,
      deltaMinor,
    };
  });

  const summary = summarizeReconciliation(rows);

  // ---- Report ----
  console.log("Summary");
  console.log(`  users:                        ${summary.users}`);
  console.log(`  IN_SYNC:                      ${summary.byStatus.IN_SYNC}`);
  console.log(`  MATCH_WINNINGS_NOT_IN_LEDGER: ${summary.byStatus.MATCH_WINNINGS_NOT_IN_LEDGER}`);
  console.log(`  LEDGER_AHEAD:                 ${summary.byStatus.LEDGER_AHEAD}`);
  console.log(`  UNEXPLAINED:                  ${summary.byStatus.UNEXPLAINED}`);
  console.log(`  net delta:                    ${gbp(summary.netDeltaMinor)}`);
  console.log(`  abs delta (true gap):         ${gbp(summary.absDeltaMinor)}`);
  console.log(`  U3 backfill credit needed:    ${gbp(summary.backfillCreditMinor)}`);
  console.log(`  safe to backfill (no UNEXPLAINED): ${isReconciliationSafeToBackfill(summary) ? "YES" : "NO"}`);

  const flagged = rows.filter((r) => r.status !== "IN_SYNC");
  if (flagged.length) {
    console.log(`\nFlagged users (${flagged.length}):`);
    for (const r of flagged.slice(0, 100)) {
      const who = r.username ? `${r.username} (${shortId(r.userId)})` : shortId(r.userId);
      console.log(
        `  ${who}: available=${gbp(r.availableMinor)} ledger=${gbp(r.ledgerMinor)} delta=${gbp(r.deltaMinor)} [${r.status}]`
      );
    }
    if (flagged.length > 100) console.log(`  …and ${flagged.length - 100} more`);
  } else {
    console.log("\nAll users IN_SYNC.");
  }
} catch (err) {
  console.error("Reconciliation failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
