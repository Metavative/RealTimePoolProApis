// utils/dbTransactions.js
//
// Phase C: several money flows (1v1 match settle/cancel, level-match
// create/settle/cancel, dispute resolution, referral commission) open Mongo
// multi-document transactions. Those REQUIRE a replica set / mongos and throw
// a cryptic error mid-operation on a standalone mongod.
//
// This guard converts that into an explicit, early, clean contract: when the
// deployment can't do transactions, the flow refuses with a 503 instead of
// attempting an operation that cannot be made atomic. Refusing is the safe
// choice for money — better no settlement than a half-applied one.

import { supportsTransactions } from "../config/db.js";

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// True when atomic transactions can be used. Honours an escape hatch
// (TX_ASSUME_SUPPORTED=true) in case the boot-time detection misreads a real
// replica set as standalone.
export function transactionsAvailable() {
  if (envFlag("TX_ASSUME_SUPPORTED", false)) return true;
  return supportsTransactions();
}

// Express guard: returns true when it is safe to proceed; otherwise writes a
// 503 response and returns false. Usage at the top of a controller:
//   if (!requireTransactions(res)) return;
export function requireTransactions(res) {
  if (transactionsAvailable()) return true;
  res.status(503).json({
    ok: false,
    code: "TRANSACTIONS_REQUIRED",
    message:
      "This operation requires a MongoDB replica set (multi-document transactions). " +
      "The server is connected to a standalone instance. Use a replica set, or set " +
      "TX_ASSUME_SUPPORTED=true if this deployment does support transactions.",
  });
  return false;
}

export default { transactionsAvailable, requireTransactions };
