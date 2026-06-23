// scripts/backup-db.mjs
//
// One-shot, READ-ONLY backup of the configured MongoDB database to local JSON
// files. Uses the connection string already in .env (MONGO_URI / MONGODB_URI)
// so it works even without MongoDB Atlas console access.
//
// Safety:
//   - Read-only: only listCollections + find(). Never writes to the database.
//   - Writes EJSON (preserves ObjectId, Date, etc.) to ./backup/<timestamp>/.
//   - Prints ONLY collection names + counts. Never prints the URI or any
//     document contents.
//
// Usage:  node scripts/backup-db.mjs
//
import "dotenv/config";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI / MONGODB_URI found in .env. Aborting.");
  process.exit(1);
}

// Timestamp folder (avoid clobbering previous backups).
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "backup", stamp);
mkdirSync(outDir, { recursive: true });

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(); // database from the connection string
  console.log(`Connected. Database: ${db.databaseName}`);

  const collections = await db.listCollections().toArray();
  console.log(`Found ${collections.length} collection(s).\n`);

  let grandTotal = 0;
  const manifest = [];

  for (const { name } of collections) {
    const docs = await db.collection(name).find({}).toArray();
    const file = join(outDir, `${name}.json`);
    writeFileSync(file, EJSON.stringify(docs, undefined, 2), "utf8");
    grandTotal += docs.length;
    manifest.push({ collection: name, count: docs.length });
    console.log(`  ${name}: ${docs.length} document(s)`);
  }

  writeFileSync(
    join(outDir, "_manifest.json"),
    JSON.stringify(
      { database: db.databaseName, takenAt: stamp, total: grandTotal, collections: manifest },
      null,
      2
    ),
    "utf8"
  );

  console.log(`\nDone. ${grandTotal} document(s) across ${collections.length} collection(s).`);
  console.log(`Backup written to: backup/${stamp}/`);
} catch (err) {
  console.error("Backup failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
