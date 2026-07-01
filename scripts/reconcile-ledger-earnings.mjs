// scripts/reconcile-ledger-earnings.mjs
//
// U0 of the ledger↔earnings unification — READ-ONLY reconciliation report.
//
// For every user it compares two numbers that are supposed to represent the
// same thing (spendable balance):
//
//   ledgerMinor  = Σ POSTED USER_WALLET credits − Σ POSTED USER_WALLET debits
//                  (minor units / pence) — the intended source of truth (U1),
//   cacheMinor   = round(earnings.availableBalance * 100)
//                  (the legacy per-user cache the Flutter client currently reads).
//
// It then classifies each user as MATCH / DRIFT / CACHE_ONLY / LEDGER_ONLY and
// prints a summary plus the worst offenders. This is the data the owner needs to
// answer the open unification questions (how much drift exists, which direction,
// whether a backfill is safe) BEFORE FEATURE_LEDGER_UNIFIED is ever flipped.
//
// Writes NOTHING. Prints NO secrets and NO document contents beyond ids + the
// two balances being reconciled. Mirrors the aggregation in
// ledgerUnification.service.js#getUserWalletBalanceMinor.
//
// By default it prints only user ids (no PII). Pass --emails to include emails
// in the drift rows when you need to eyeball specific accounts.
//
//   node scripts/reconcile-ledger-earnings.mjs [--currency GBP] [--top 25] [--json] [--emails]
//
import "dotenv/config";
import { MongoClient } from "mongodb";

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CURRENCY = String(argVal("--currency", "GBP")).toUpperCase();
const TOP = Math.max(1, parseInt(argVal("--top", "25"), 10) || 25);
const AS_JSON = process.argv.includes("--json");
const WITH_EMAILS = process.argv.includes("--emails");

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

function money(minor) {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}£${(abs / 100).toFixed(2)}`;
}

try {
  await client.connect();
  const db = client.db();

  // 1) Per-user authoritative USER_WALLET balance from the ledger, in one pass.
  const walletRows = await db
    .collection("ledgerentries")
    .aggregate([
      { $match: { accountType: "USER_WALLET", currency: CURRENCY, status: "POSTED" } },
      {
        $group: {
          _id: "$accountId",
          creditMinor: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
          debitMinor: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
        },
      },
    ])
    .toArray();

  const ledgerByUser = new Map();
  for (const r of walletRows) {
    ledgerByUser.set(String(r._id), Number(r.creditMinor || 0) - Number(r.debitMinor || 0));
  }

  // Note any non-target-currency USER_WALLET activity so the report isn't silently partial.
  const otherCurrencies = await db
    .collection("ledgerentries")
    .distinct("currency", { accountType: "USER_WALLET", status: "POSTED", currency: { $ne: CURRENCY } });

  // 2) Walk users, compare against the earnings cache.
  const cursor = db
    .collection("users")
    .find(
      {},
      { projection: { _id: 1, "earnings.availableBalance": 1, ...(WITH_EMAILS ? { email: 1 } : {}) } }
    );

  const rows = [];
  const buckets = { MATCH: 0, DRIFT: 0, CACHE_ONLY: 0, LEDGER_ONLY: 0 };
  let totalLedgerMinor = 0;
  let totalCacheMinor = 0;
  let totalAbsDriftMinor = 0;
  const seenLedgerUsers = new Set();

  for await (const u of cursor) {
    const uid = String(u._id);
    const ledgerMinor = ledgerByUser.get(uid) ?? 0;
    if (ledgerByUser.has(uid)) seenLedgerUsers.add(uid);
    const cacheMajor = Number(u?.earnings?.availableBalance || 0);
    const cacheMinor = Math.round(cacheMajor * 100);
    const driftMinor = ledgerMinor - cacheMinor;

    totalLedgerMinor += ledgerMinor;
    totalCacheMinor += cacheMinor;
    totalAbsDriftMinor += Math.abs(driftMinor);

    let cls;
    if (driftMinor === 0) cls = "MATCH";
    else if (cacheMinor > 0 && ledgerMinor === 0) cls = "CACHE_ONLY"; // cache money with no ledger backing
    else if (ledgerMinor > 0 && cacheMinor === 0) cls = "LEDGER_ONLY"; // ledger money not reflected in cache
    else cls = "DRIFT";
    buckets[cls] += 1;

    if (driftMinor !== 0) {
      rows.push({ uid, email: WITH_EMAILS ? u.email || "" : "", ledgerMinor, cacheMinor, driftMinor, cls });
    }
  }

  // Ledger USER_WALLET accountIds that don't correspond to any user document.
  const orphanLedgerUsers = [...ledgerByUser.keys()].filter((id) => !seenLedgerUsers.has(id));

  rows.sort((a, b) => Math.abs(b.driftMinor) - Math.abs(a.driftMinor));

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          currency: CURRENCY,
          database: db.databaseName,
          buckets,
          totals: {
            ledgerMinor: totalLedgerMinor,
            cacheMinor: totalCacheMinor,
            netDriftMinor: totalLedgerMinor - totalCacheMinor,
            absDriftMinor: totalAbsDriftMinor,
          },
          otherCurrencies,
          orphanLedgerUsers,
          drifts: rows,
        },
        null,
        2
      )
    );
  } else {
    const totalUsers = buckets.MATCH + buckets.DRIFT + buckets.CACHE_ONLY + buckets.LEDGER_ONLY;
    console.log(`\nLedger↔earnings reconciliation (U0)  —  READ-ONLY`);
    console.log(`  database: ${db.databaseName}   currency: ${CURRENCY}   users: ${totalUsers}\n`);
    console.log(`  MATCH        ${buckets.MATCH}\t(ledger balance == earnings.availableBalance)`);
    console.log(`  DRIFT        ${buckets.DRIFT}\t(both non-zero but unequal)`);
    console.log(`  CACHE_ONLY   ${buckets.CACHE_ONLY}\t(cache shows money, ledger has none — over-credit risk)`);
    console.log(`  LEDGER_ONLY  ${buckets.LEDGER_ONLY}\t(ledger has money, cache shows £0 — client under-reports)`);
    console.log(`\n  Σ ledger spendable: ${money(totalLedgerMinor)}`);
    console.log(`  Σ cache spendable:  ${money(totalCacheMinor)}`);
    console.log(`  net drift (ledger − cache): ${money(totalLedgerMinor - totalCacheMinor)}`);
    console.log(`  gross drift (Σ|diff|):      ${money(totalAbsDriftMinor)}`);

    if (otherCurrencies.length) {
      console.log(`\n  ⚠ USER_WALLET activity also exists in: ${otherCurrencies.join(", ")} (not counted above).`);
    }
    if (orphanLedgerUsers.length) {
      console.log(`\n  ⚠ ${orphanLedgerUsers.length} USER_WALLET ledger accountId(s) have no matching user doc.`);
    }

    if (rows.length) {
      const n = Math.min(TOP, rows.length);
      console.log(`\n  Top ${n} drifts (by magnitude):`);
      console.log(`    ${"class".padEnd(12)}${"ledger".padStart(12)}${"cache".padStart(12)}${"drift".padStart(12)}   user`);
      for (const r of rows.slice(0, n)) {
        console.log(
          `    ${r.cls.padEnd(12)}${money(r.ledgerMinor).padStart(12)}${money(r.cacheMinor).padStart(12)}${money(r.driftMinor).padStart(12)}   ${r.uid}${r.email ? "  " + r.email : ""}`
        );
      }
      if (rows.length > n) console.log(`    … and ${rows.length - n} more (use --top ${rows.length} or --json).`);
    } else {
      console.log(`\n  No drift — every user's ledger balance matches their earnings cache. ✅`);
    }
    console.log("");
  }
} catch (err) {
  console.error("Reconciliation failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close();
}
