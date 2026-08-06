// scripts/demo-finished.mjs   (DEMO db only)
//
// Sets up a COMPLETED tournament in the isolated demo db where the demo player is
// the champion and the prize pool is funded by paid entries — so we can show the
// organiser settling prizes and the winner's wallet being credited, live in the app.
//
//   node scripts/demo-finished.mjs            -> seed the finished (unsettled) tournament
//   node scripts/demo-finished.mjs --settle   -> run the organiser prize settlement
//
import "dotenv/config";
import mongoose from "mongoose";

const DB = process.env.MONGO_DB_NAME || "poolpro_demo";
if (DB === "poolpro") { console.error("Refusing to run against production."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
const User = (await import("../src/models/user.model.js")).default;
const Tournament = (await import("../src/models/tournament.model.js")).default;
const TournamentEntryOrder = (await import("../src/models/tournamentEntryOrder.model.js")).default;

const TITLE = "Sunday Masters (Demo)";
const settle = process.argv.includes("--settle");

const demo = await User.findOne({ email: "demo@poolpro.app" }).lean();
if (!demo) { console.error("demo@poolpro.app not found in demo db — run seed-demo.mjs first."); process.exit(1); }
const champKey = `uid:${demo._id}`;

async function walletAndEarned() {
  const L = mongoose.connection.collection("ledgerentries");
  const rows = await L.aggregate([
    { $match: { accountType: "USER_WALLET", accountId: String(demo._id), status: "POSTED" } },
    { $group: { _id: null, c: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } }, d: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } } } },
  ]).toArray();
  const wallet = ((rows[0]?.c || 0) - (rows[0]?.d || 0)) / 100;
  const u = await User.findById(demo._id).lean();
  const earned = Number(u?.earnings?.total || 0);
  return { wallet, earned };
}

if (!settle) {
  await Tournament.deleteMany({ title: TITLE });
  await TournamentEntryOrder.deleteMany({ orderId: { $regex: "^ORD-SM-" } });

  const clubId = new mongoose.Types.ObjectId();
  const t = await Tournament.create({
    title: TITLE,
    clubId,
    format: "knockout",
    accessMode: "OPEN",
    entriesStatus: "CLOSED",
    status: "COMPLETED",
    championName: champKey,
    defaultVenue: "The Corner Pocket",
    entrants: [{ entrantId: demo._id, participantKey: champKey, userId: String(demo._id), name: "Demo Player" }],
    economy: { enabled: true, currency: "GBP", entryFeeMinor: 500, organizerShareBps: 3000, prizePoolBps: 7000 },
  });
  // 4 paid entries -> prize pool = 4 x £3.50 = £14.00
  for (let i = 0; i < 4; i++) {
    await TournamentEntryOrder.create({
      orderId: `ORD-SM-${i + 1}`, tournamentId: t._id, userId: new mongoose.Types.ObjectId(),
      status: "PAID", amountMinor: 500, prizePoolMinor: 350,
    });
  }
  const before = await walletAndEarned();
  console.log(`Seeded finished tournament "${TITLE}" (${t._id})`);
  console.log(`  Champion: Demo Player   Prize pool: £14.00 (from 4 paid entries)`);
  console.log(`  Demo player NOW -> wallet £${before.wallet.toFixed(2)}, earned £${before.earned.toFixed(2)}  (not yet settled)`);
} else {
  const { settleTournamentPrizes } = await import("../src/services/tournamentPayout.service.js");
  const t = await Tournament.findOne({ title: TITLE });
  if (!t) { console.error("Seed first (run without --settle)."); process.exit(1); }
  const before = await walletAndEarned();
  const r = await settleTournamentPrizes(String(t._id));
  const after = await walletAndEarned();
  console.log(`Organiser settled prizes for "${TITLE}":`, JSON.stringify(r));
  console.log(`  Demo player wallet: £${before.wallet.toFixed(2)} -> £${after.wallet.toFixed(2)}`);
  console.log(`  Demo player earned: £${before.earned.toFixed(2)} -> £${after.earned.toFixed(2)}`);
}

await mongoose.disconnect();
