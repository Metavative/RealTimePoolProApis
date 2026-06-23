// scripts/run-integration.mjs
//
// Runs the DB-backed integration suite against the cluster configured in .env,
// WITHOUT putting the connection string on the command line. The suite itself
// always uses an isolated `poolpro_integration_test` database (created + dropped
// each run), so real data is never touched.
//
import "dotenv/config";

if (!process.env.TEST_MONGO_URI) {
  process.env.TEST_MONGO_URI =
    process.env.MONGO_URI || process.env.MONGODB_URI || "";
}

if (!process.env.TEST_MONGO_URI) {
  console.error("No MONGO_URI in .env to derive TEST_MONGO_URI from.");
  process.exit(1);
}

await import("../test/integration.test.js");
