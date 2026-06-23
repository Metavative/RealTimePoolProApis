// scripts/check-db.mjs
//
// READ-ONLY connectivity + capability check for the currently-configured
// MONGO_URI (.env). Confirms the app can reach the cluster, which database it
// resolves to, what collections exist (with counts), and whether the deployment
// supports multi-document transactions (replica set / mongos).
//
// Prints NO secrets and NO document contents.
//
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db();
  const hello = await db.admin().command({ hello: 1 });
  const isReplicaSet = Boolean(hello?.setName);
  const isMongos = hello?.msg === "isdbgrid";
  const txOk = isReplicaSet || isMongos;

  console.log(`Connected OK.`);
  console.log(`  database: ${db.databaseName}`);
  console.log(`  deployment: ${isReplicaSet ? `replica set (${hello.setName})` : isMongos ? "sharded (mongos)" : "standalone"}`);
  console.log(`  transactions supported: ${txOk ? "YES" : "NO"}`);

  const cols = await db.listCollections().toArray();
  let total = 0;
  console.log(`  collections: ${cols.length}`);
  for (const { name } of cols) {
    const n = await db.collection(name).countDocuments();
    total += n;
    if (n > 0) console.log(`    ${name}: ${n}`);
  }
  console.log(`  total documents: ${total}`);
} catch (err) {
  console.error("Check failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
