// scripts/find-admins.mjs
//
// READ-ONLY. Lists any user account that would pass the platform-admin check
// (hasPlatformAdminAccess): explicit admin flags, an exact admin role, or the
// ADMIN_EMAILS allow-list. Prints identifiers only — NEVER passwords/hashes.
//
import "dotenv/config";
import { MongoClient } from "mongodb";

const PLATFORM_ADMIN_ROLES = new Set([
  "admin",
  "superadmin",
  "super_admin",
  "platform_admin",
  "platformadmin",
  "root",
]);

function rolesOf(u) {
  return [
    u?.role,
    u?.userType,
    u?.accountType,
    u?.profile?.role,
    u?.profile?.userType,
    u?.profile?.type,
  ]
    .map((c) => String(c ?? "").trim().toLowerCase())
    .filter(Boolean);
}

function allowList() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(u) {
  if (u?.isAdmin === true || u?.isPlatformAdmin === true) return true;
  if (u?.profile?.isPlatformAdmin === true || u?.profile?.isAdmin === true) return true;
  for (const r of rolesOf(u)) if (PLATFORM_ADMIN_ROLES.has(r)) return true;
  const email = String(u?.email ?? "").toLowerCase();
  if (email && allowList().includes(email)) return true;
  return false;
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db();
  const users = await db
    .collection("users")
    .find({}, { projection: { email: 1, username: 1, phone: 1, role: 1, userType: 1, accountType: 1, profile: 1, isAdmin: 1, isPlatformAdmin: 1, createdAt: 1 } })
    .toArray();

  const admins = users.filter(isAdmin);
  console.log(`database: ${db.databaseName}`);
  console.log(`total users: ${users.length}`);
  console.log(`ADMIN_EMAILS allow-list: ${allowList().length ? allowList().join(", ") : "(none set)"}`);
  console.log(`admin accounts found: ${admins.length}`);
  console.log("");

  if (admins.length === 0) {
    console.log("No admin accounts exist. Every user's role:");
    for (const u of users) {
      console.log(
        `  - ${u.email || u.username || u._id}  roles=[${rolesOf(u).join(", ") || "—"}]`
      );
    }
  } else {
    for (const u of admins) {
      console.log(`  ✔ ${u.email || "(no email)"}  username=${u.username || "—"}  roles=[${rolesOf(u).join(", ")}]`);
    }
  }
} catch (err) {
  console.error("Query failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
