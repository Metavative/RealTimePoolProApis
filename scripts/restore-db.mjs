// scripts/restore-db.mjs
//
// Restores a local EJSON backup (produced by backup-db.mjs) into the database
// configured in .env (MONGO_URI). Intended to seed the new Atlas cluster with
// the data captured from the old one.
//
// - Auto-selects the most recent folder under ./backup unless one is passed:
//     node scripts/restore-db.mjs [backupFolderName]
// - Skips empty collections and the _manifest.json file.
// - Uses insertMany({ ordered: false }) and tolerates duplicate-key errors, so
//   re-running is safe (already-present _id docs are skipped, not duplicated).
// - Prints ONLY collection names + inserted counts. No document contents.
//
import "dotenv/config";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backupRoot = join(here, "..", "backup");

// Resolve which backup folder to restore from.
let folder = process.argv[2];
if (!folder) {
  const dirs = readdirSync(backupRoot).filter((d) => {
    try {
      return statSync(join(backupRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) {
    console.error("No backup folders found under ./backup");
    process.exit(1);
  }
  dirs.sort(); // timestamp names sort chronologically
  folder = dirs[dirs.length - 1];
}
const srcDir = join(backupRoot, folder);
console.log(`Restoring from: backup/${folder}`);

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const files = readdirSync(srcDir).filter(
  (f) => f.endsWith(".json") && f !== "_manifest.json"
);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db();
  console.log(`Target database: ${db.databaseName}\n`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    const docs = EJSON.parse(readFileSync(join(srcDir, file), "utf8"));
    if (!Array.isArray(docs) || docs.length === 0) continue;

    try {
      const result = await db
        .collection(name)
        .insertMany(docs, { ordered: false });
      totalInserted += result.insertedCount;
      console.log(`  ${name}: inserted ${result.insertedCount}/${docs.length}`);
    } catch (err) {
      // Duplicate-key errors (code 11000) mean those _ids already exist — fine.
      const inserted = err?.result?.insertedCount ?? err?.insertedCount ?? 0;
      const dupes = (err?.writeErrors || []).filter((e) => e.code === 11000).length;
      totalInserted += inserted;
      totalSkipped += dupes;
      if (dupes && inserted + dupes === docs.length) {
        console.log(`  ${name}: inserted ${inserted}, skipped ${dupes} existing`);
      } else {
        console.log(`  ${name}: inserted ${inserted}, issues on ${docs.length - inserted} (${err?.code || "?"})`);
      }
    }
  }

  console.log(`\nDone. Inserted ${totalInserted}, skipped ${totalSkipped} already-present.`);
} catch (err) {
  console.error("Restore failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
