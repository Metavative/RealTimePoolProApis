// Back-office payout settlement tool (player withdrawals + organiser payouts).
//
// There is no admin frontend, and payout settlement releases real money, so it
// is a trusted ops action. This CLI reuses the EXACT admin controller logic
// (adminListPayouts / adminCompletePayout / adminFailPayout) in-process against
// the configured DB — no duplicated ledger logic, no HTTP/auth needed (running
// the script IS the operator authorisation).
//
// Usage:
//   node scripts/admin-payouts.mjs list [status] [player|organizer]
//   node scripts/admin-payouts.mjs complete <payoutId> [providerReference]
//   node scripts/admin-payouts.mjs fail     <payoutId> [reason]
//
// Examples:
//   node scripts/admin-payouts.mjs list REQUESTED
//   node scripts/admin-payouts.mjs complete PO_1782_123456 BANKREF-9981
//   node scripts/admin-payouts.mjs fail OPO_1782_123456 "invalid bank details"
import fs from "node:fs";
import mongoose from "mongoose";

// Settlement endpoints are gated behind FEATURE_PAYMENTS_V2; this is a
// deliberate ops run, so enable it for the process.
process.env.FEATURE_PAYMENTS_V2 = "true";

const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const uri =
  (env.match(/^MONGO_URI=(.*)$/m) || [])[1]?.trim() || process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI not found (.env or env var).");
  process.exit(1);
}

const [, , cmd, arg1, arg2] = process.argv;

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

const adminReq = (extra = {}) => ({
  user: { role: "admin", profile: { role: "admin" } },
  params: {},
  body: {},
  query: {},
  ...extra,
});

function money(minor, currency) {
  return `${(Number(minor || 0) / 100).toFixed(2)} ${currency || "GBP"}`;
}

await mongoose.connect(uri);

const { adminListPayouts, adminCompletePayout, adminFailPayout } = await import(
  "../src/controllers/payments.controller.js"
);

try {
  if (cmd === "list") {
    const res = mkRes();
    await adminListPayouts(
      adminReq({
        query: {
          status: (arg1 || "").toUpperCase(),
          type: (arg2 || "").toUpperCase(),
          limit: "200",
        },
      }),
      res
    );
    const payouts = res.body?.payouts || [];
    if (!payouts.length) {
      console.log("No payouts found.");
    } else {
      console.log(
        "PAYOUT ID".padEnd(26) +
          "TYPE".padEnd(11) +
          "STATUS".padEnd(14) +
          "AMOUNT".padEnd(14) +
          "OWNER"
      );
      for (const p of payouts) {
        console.log(
          String(p.payoutId).padEnd(26) +
            String(p.type).padEnd(11) +
            String(p.status).padEnd(14) +
            money(p.amountMinor, p.currency).padEnd(14) +
            (p.type === "ORGANIZER" ? `club=${p.clubId}` : `user=${p.userId}`)
        );
      }
      console.log(`\n${payouts.length} payout(s).`);
    }
  } else if (cmd === "complete") {
    if (!arg1) throw new Error("Usage: complete <payoutId> [providerReference]");
    const res = mkRes();
    await adminCompletePayout(
      adminReq({
        params: { payoutId: arg1 },
        body: { providerReference: arg2 || "" },
      }),
      res
    );
    console.log(`HTTP ${res.statusCode}`);
    console.log(JSON.stringify(res.body, null, 2));
  } else if (cmd === "fail") {
    if (!arg1) throw new Error("Usage: fail <payoutId> [reason]");
    const res = mkRes();
    await adminFailPayout(
      adminReq({
        params: { payoutId: arg1 },
        body: { reason: arg2 || "Failed by back-office" },
      }),
      res
    );
    console.log(`HTTP ${res.statusCode}`);
    console.log(JSON.stringify(res.body, null, 2));
  } else {
    console.log(
      [
        "Usage:",
        "  node scripts/admin-payouts.mjs list [status] [player|organizer]",
        "  node scripts/admin-payouts.mjs complete <payoutId> [providerReference]",
        "  node scripts/admin-payouts.mjs fail     <payoutId> [reason]",
      ].join("\n")
    );
  }
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
