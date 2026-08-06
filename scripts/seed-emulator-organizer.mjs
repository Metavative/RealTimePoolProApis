// Seeds an ORGANISER (club) account plus a few players into a scratch database
// so the tournament flow can be driven by hand on an emulator.
//
// Usage:
//   MONGO_DB_NAME=poolpro_verify node scripts/seed-emulator-organizer.mjs
//
// Refuses to run against the production database.

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const DB_NAME = process.env.MONGO_DB_NAME || "poolpro_verify";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("MONGO_URI missing (.env)");
  process.exit(1);
}
if (DB_NAME === "poolpro") {
  console.error("Refusing to seed the production database 'poolpro'.");
  process.exit(1);
}

const EMAIL = process.env.SEED_CLUB_EMAIL || "organizer@poolpro.test";
const PASSWORD = process.env.SEED_CLUB_PASSWORD || "Organizer@12345";

await mongoose.connect(MONGO_URI, { dbName: DB_NAME });

const User = (await import("../src/models/user.model.js")).default;
const Club = (await import("../src/models/club.model.js")).default;

const hash = await bcrypt.hash(PASSWORD, 10);

// Owner user for the club (clubAuthMiddleware resolves one).
let owner = await User.findOne({ email: EMAIL });
if (!owner) {
  owner = await User.create({
    username: "demo_organizer",
    email: EMAIL,
    passwordHash: hash,
    password: hash,
    profile: { nickname: "Demo Organizer", firstName: "Demo", lastName: "Organizer", role: "USER" },
  });
} else {
  owner.passwordHash = hash;
  owner.password = hash;
  await owner.save();
}

let club = await Club.findOne({ email: EMAIL });
if (!club) {
  club = await Club.create({
    name: "Demo Pool Club",
    email: EMAIL,
    passwordHash: hash,
    password: hash,
    owner: owner._id,
    status: "ACTIVE",
  });
} else {
  club.passwordHash = hash;
  club.password = hash;
  club.owner = owner._id;
  club.status = "ACTIVE";
  await club.save();
}

// A handful of findable app users to search for and invite.
const players = [
  { username: "mattpotter", nickname: "Matt Potter" },
  { username: "sam", nickname: "Sam Reeve" },
  { username: "joroberts", nickname: "Jo Roberts" },
  { username: "kai", nickname: "Kai Chen" },
];

for (const p of players) {
  const existing = await User.findOne({ username: p.username });
  if (existing) continue;
  await User.create({
    username: p.username,
    email: `${p.username}@players.test`,
    passwordHash: hash,
    password: hash,
    profile: { nickname: p.nickname, role: "USER" },
  });
}

console.log("Seeded into db:", DB_NAME);
console.log("  ORGANISER login :", EMAIL, "/", PASSWORD);
console.log("  players         :", players.map((p) => p.username).join(", "));

await mongoose.disconnect();
process.exit(0);
