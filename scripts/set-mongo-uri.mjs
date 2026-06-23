// scripts/set-mongo-uri.mjs
//
// Repoints the backend at a new MongoDB cluster by reading the connection
// string from an Atlas credentials file and writing MONGO_URI / MONGODB_URI
// into .env — WITHOUT ever printing the password.
//
// - Forces the database name in the URI path to `poolpro` (the app derives the
//   db from the URI path; the Atlas onboarding URI has no db in it).
// - Preserves all other lines in .env. Replaces existing MONGO_URI/MONGODB_URI
//   lines, or appends them if absent.
// - Prints ONLY a redacted confirmation (username + host + db). Never the password.
//
// Usage:  node scripts/set-mongo-uri.mjs "C:\\Users\\karac\\Downloads\\atlas-credentials.env"
//
import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_NAME = "poolpro";
const credsPath = process.argv[2] || "C:\\Users\\karac\\Downloads\\atlas-credentials.env";

if (!existsSync(credsPath)) {
  console.error(`Credentials file not found: ${credsPath}`);
  process.exit(1);
}

// Parse the creds file in isolation (do NOT pollute process.env).
const parsed = dotenv.parse(readFileSync(credsPath));
let rawUri = (parsed.MONGODB_URI || parsed.MONGO_URI || "").trim();
if (!rawUri) {
  console.error("No MONGODB_URI found inside the credentials file.");
  process.exit(1);
}
if (rawUri.includes("<db_password>") || rawUri.includes("<password>")) {
  console.error("The connection string still has a <db_password> placeholder — the real password is missing.");
  process.exit(1);
}

// Force the database path to /poolpro, preserving the query string.
// Matches: <scheme>://<user:pass@host>[/<oldpath>][?<query>]
const normalized = rawUri.replace(
  /^(mongodb(?:\+srv)?:\/\/[^/]+)(?:\/[^?]*)?(\?.*)?$/,
  (_m, base, query) => `${base}/${DB_NAME}${query || ""}`
);
if (normalized === rawUri && !rawUri.includes(`/${DB_NAME}`)) {
  console.error("Could not parse the connection string into scheme/host — leaving .env unchanged.");
  process.exit(1);
}

// Redacted confirmation only.
const userMatch = normalized.match(/\/\/([^:]+):/);
const hostMatch = normalized.match(/@([^/?]+)/);
const redactedUser = userMatch ? userMatch[1] : "(unknown)";
const redactedHost = hostMatch ? hostMatch[1] : "(unknown)";

// Update .env (backup the old one first).
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");
let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

if (existsSync(envPath)) {
  copyFileSync(envPath, `${envPath}.bak`);
}

function upsert(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}${line}\n`;
}

envText = upsert(envText, "MONGO_URI", normalized);
envText = upsert(envText, "MONGODB_URI", normalized);
writeFileSync(envPath, envText, "utf8");

console.log("Updated .env MONGO_URI / MONGODB_URI (old .env saved as .env.bak).");
console.log(`  user: ${redactedUser}`);
console.log(`  host: ${redactedHost}`);
console.log(`  db:   ${DB_NAME}`);
console.log("Password was read and written but never printed.");
