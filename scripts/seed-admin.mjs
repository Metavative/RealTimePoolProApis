// scripts/seed-admin.mjs
//
// Provision a fixed platform-admin account for the back-office dashboard.
// Idempotent: creates the account if missing, or (re)sets its password + admin
// role if the email already exists. Safe to re-run.
//
// Credentials come from env with sensible defaults:
//   ADMIN_SEED_EMAIL     (default admin@poolpro.app)
//   ADMIN_SEED_PASSWORD  (default Admin@12345)
//
// Writes a bcrypt hash to BOTH `passwordHash` and `password` (login reads
// passwordHash || password) and sets profile.role/userType = "admin" plus the
// explicit isPlatformAdmin flag, so hasPlatformAdminAccess() grants access.
//
// Prints NO password hash.
//
import "dotenv/config";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

const EMAIL = String(process.env.ADMIN_SEED_EMAIL || "admin@poolpro.app")
  .trim()
  .toLowerCase();
const PASSWORD = String(process.env.ADMIN_SEED_PASSWORD || "Admin@12345");

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db();
  const users = db.collection("users");

  const hash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();

  const existing = await users.findOne({ email: EMAIL }, { projection: { _id: 1 } });

  const setDoc = {
    email: EMAIL,
    passwordHash: hash,
    password: hash,
    "profile.role": "admin",
    "profile.userType": "admin",
    "profile.isPlatformAdmin": true,
    "profile.active": true,
    isPlatformAdmin: true,
    emailVerified: true,
    updatedAt: now,
  };

  const setOnInsert = {
    "profile.nickname": "Administrator",
    "stats.userIdTag": "admin_seed",
    phoneVerified: false,
    createdAt: now,
  };

  await users.updateOne(
    { email: EMAIL },
    { $set: setDoc, $setOnInsert: setOnInsert },
    { upsert: true }
  );

  console.log(`database: ${db.databaseName}`);
  console.log(existing ? "action: UPDATED existing account" : "action: CREATED new account");
  console.log("");
  console.log("  Admin login:");
  console.log(`    email:    ${EMAIL}`);
  console.log(`    password: ${PASSWORD}`);
  console.log("");
  console.log("  Role: admin (platform-admin). Log in at the dashboard /login.");
} catch (err) {
  console.error("Seed failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
