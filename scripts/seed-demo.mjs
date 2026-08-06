// scripts/seed-demo.mjs
//
// Seed an ISOLATED demo database (poolpro_demo on the same cluster) so we can run
// a local backend with every feature flag ON and walk the paid money loop in the
// app WITHOUT touching the production `poolpro` data.
//
// Seeds: a demo player login, the store catalogue, one OPEN paid tournament (so
// the player can discover + enter it) and one free tournament for contrast.
//
// Run: MONGO_DB_NAME=poolpro_demo node scripts/seed-demo.mjs
//
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

const DB = process.env.MONGO_DB_NAME || "poolpro_demo";
const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}
if (DB === "poolpro") {
  console.error("Refusing to seed the production `poolpro` database. Set MONGO_DB_NAME to a demo db.");
  process.exit(1);
}

await mongoose.connect(uri, { dbName: DB });
const User = (await import("../src/models/user.model.js")).default;
const StoreItem = (await import("../src/models/storeItem.model.js")).default;
const Tournament = (await import("../src/models/tournament.model.js")).default;

console.log(`Seeding demo database: ${DB}`);

// Start clean (safe: isolated demo db only).
await mongoose.connection.dropDatabase();

// ---- Demo player login ----
const email = "demo@poolpro.app";
const password = "Demo@12345";
const hash = await bcrypt.hash(password, 10);
const now = new Date();

const demo = await User.create({
  email,
  passwordHash: hash,
  password: hash,
  username: "demoplayer",
  emailVerified: true,
  phoneVerified: false,
  profile: {
    nickname: "Demo Player",
    role: "player",
    userType: "player",
    firstName: "Demo",
    lastName: "Player",
    verified: true,
    active: true,
    fairPlay: 5.0,
  },
  stats: { userIdTag: "player_demo01", score: 120, gamesWon: 8, gamesLost: 3, gamesDrawn: 1, totalWinnings: 0 },
  earnings: { career: 0, total: 0, availableBalance: 0, entryFeesPaid: 0 },
});

// A couple of extra players so leaderboards/rosters aren't lonely.
const others = [];
for (const [i, n] of ["Jordan", "Priya", "Marcus", "Lena"].entries()) {
  others.push(
    await User.create({
      email: `p${i + 1}@demo.poolpro.app`,
      passwordHash: hash,
      password: hash,
      username: `demo_${n.toLowerCase()}`,
      emailVerified: true,
      profile: { nickname: n, role: "player", userType: "player", verified: true, active: true },
      stats: { userIdTag: `player_demo0${i + 2}`, score: 200 - i * 30, totalWinnings: (5 - i) * 10 },
      earnings: { career: (5 - i) * 10, total: (5 - i) * 10, availableBalance: 0 },
    })
  );
}

// ---- Store catalogue ----
const img = (seed) => `https://picsum.photos/seed/poolpro-${seed}/600/600`;
const ITEMS = [
  { sku: "CUE-ASH-STD", type: "CUE", name: "Ashwood Classic Cue", rarity: "COMMON", price: 39.99, stockQty: 50 },
  { sku: "CUE-MAPLE-PRO", type: "CUE", name: "Maple Pro Series Cue", rarity: "RARE", price: 89.99, stockQty: 30 },
  { sku: "CUE-CARBON-X", type: "CUE", name: "Carbon-X Tournament Cue", rarity: "EPIC", price: 199.99, stockQty: 15 },
  { sku: "TBL-CLUB-7FT", type: "TABLE", name: "Club 7ft Pro Table", rarity: "RARE", price: 999.0, stockQty: 5 },
  { sku: "TBL-ARENA-9FT", type: "TABLE", name: "Arena 9ft Championship Table", rarity: "EPIC", price: 2499.0, stockQty: 2 },
  { sku: "ACC-CHALK-3PK", type: "ACCESSORY", name: "Master Chalk (3 pack)", rarity: "COMMON", price: 4.99, stockQty: 200 },
  { sku: "ACC-GLOVE-PRO", type: "ACCESSORY", name: "Pro Shooting Glove", rarity: "COMMON", price: 12.99, stockQty: 120 },
  { sku: "ACC-CASE-HARD", type: "ACCESSORY", name: "Hard Shell Cue Case", rarity: "RARE", price: 44.99, stockQty: 40 },
];
for (let i = 0; i < ITEMS.length; i++) {
  const it = ITEMS[i];
  await StoreItem.create({
    ...it, currency: "GBP", active: true, visibility: "GLOBAL", sortOrder: i,
    images: { thumbUrl: img(it.sku), previewUrl: img(it.sku), gallery: [img(it.sku)] },
    tags: [it.type.toLowerCase(), it.rarity.toLowerCase()],
  });
}

// ---- Tournaments ----
const clubId = new mongoose.Types.ObjectId();
const paid = await Tournament.create({
  title: "Friday Night 8-Ball League",
  clubId,
  format: "knockout",
  accessMode: "OPEN",
  entriesStatus: "OPEN",
  status: "DRAFT",
  formatStatus: "DRAFT",
  maxPlayers: 8,
  defaultVenue: "The Corner Pocket",
  economy: {
    enabled: true, currency: "GBP", entryFeeMinor: 500,
    organizerShareBps: 3000, prizePoolBps: 7000, platformFeeBps: 0, autoAddEntrantOnPayment: true,
  },
});
const free = await Tournament.create({
  title: "Casual Knockout (Free)",
  clubId,
  format: "knockout",
  accessMode: "OPEN",
  entriesStatus: "OPEN",
  status: "DRAFT",
  formatStatus: "DRAFT",
  maxPlayers: 16,
  defaultVenue: "Community Hall",
  economy: { enabled: false, currency: "GBP", entryFeeMinor: 1 },
});

console.log("");
console.log("Demo login:");
console.log(`  email:    ${email}`);
console.log(`  password: ${password}`);
console.log("");
console.log(`Users: ${1 + others.length}  Store items: ${ITEMS.length}`);
console.log(`Paid tournament:  "${paid.title}"  (£5 entry, OPEN, discoverable)`);
console.log(`Free tournament:  "${free.title}"`);
console.log("");
console.log("Start the backend with:  MONGO_DB_NAME=poolpro_demo FEATURE_PAYMENTS_V2=true ... node src/index.js");

await mongoose.disconnect();
