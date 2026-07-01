// One-off cleanup of the local payments retest data for a SINGLE user
// (default: test user "Shayan"). Removes only that user's wallet ledger
// entries, the balanced contra entries for those specific transactions
// (matched by sourceId), their wallet top-up intents, payouts and holds —
// restoring the wallet to £0. Reads MONGO_URI from .env. Read-then-delete,
// scoped by userId; it never touches other users' data.
//
// Usage:  node scripts/cleanup-test-wallet.mjs [userId]
import fs from "node:fs";
import { MongoClient, ObjectId } from "mongodb";

const userId = (process.argv[2] || "6a42561085d08965c559e006").trim();
const env = fs.readFileSync(".env", "utf8");
const uri = (env.match(/^MONGO_URI=(.*)$/m) || [])[1].trim();
if (!uri) {
  console.error("MONGO_URI not found in .env");
  process.exit(1);
}

const c = new MongoClient(uri);
await c.connect();
const db = c.db();
const oid = new ObjectId(userId);

const intents = await db
  .collection("paymentintents")
  .find({ userId: oid, module: "WALLET_TOPUP" })
  .toArray();
const payouts = await db.collection("payouts").find({ userId: oid }).toArray();
console.log(`User ${userId}: topup intents=${intents.length}, payouts=${payouts.length}`);

const sourceIds = new Set();
for (const it of intents) sourceIds.add(`SETTLE_${it.intentId}`.toUpperCase());
for (const p of payouts) sourceIds.add(String(p.payoutId).toUpperCase());

const holdAccts = [];
for (const p of payouts) {
  holdAccts.push(`WD_${p.payoutId}`);
  if (p.metadata && p.metadata.holdAccountId) holdAccts.push(p.metadata.holdAccountId);
}

const r1 = await db
  .collection("ledgerentries")
  .deleteMany({ sourceId: { $in: [...sourceIds] } });
const r2 = await db
  .collection("ledgerentries")
  .deleteMany({ accountType: "USER_WALLET", accountId: userId });
const r3 = await db
  .collection("ledgerentries")
  .deleteMany({ accountType: "HOLD_BALANCE", accountId: { $in: holdAccts } });
const r4 = await db
  .collection("paymentintents")
  .deleteMany({ userId: oid, module: "WALLET_TOPUP" });
const r5 = await db.collection("payouts").deleteMany({ userId: oid });
const r6 = await db.collection("walletholds").deleteMany({ userId: oid });

console.log(
  `Deleted -> ledger(bySource):${r1.deletedCount} ledger(wallet):${r2.deletedCount} ` +
    `ledger(hold):${r3.deletedCount} intents:${r4.deletedCount} payouts:${r5.deletedCount} holds:${r6.deletedCount}`
);

const rows = await db
  .collection("ledgerentries")
  .aggregate([
    { $match: { accountType: "USER_WALLET", accountId: userId, status: "POSTED" } },
    {
      $group: {
        _id: null,
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
      },
    },
  ])
  .toArray();
const r = rows[0] || { credit: 0, debit: 0 };
console.log(`VERIFY wallet balanceMinor = ${r.credit - r.debit} (expected 0)`);

await c.close();
