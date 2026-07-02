// scripts/mypos-preflight.mjs
//
// Go-live readiness check for myPOS payments. READ-ONLY: touches no database,
// contacts no gateway, moves no money. It validates that the environment is
// configured coherently so you can flip production on with confidence.
//
// Run against whatever env you want to inspect, e.g. locally:
//   node scripts/mypos-preflight.mjs
// or with the production values loaded into the shell.
//
import "dotenv/config";
import { createPrivateKey, createPublicKey } from "node:crypto";

function flag(name, def = false) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (v === "") return def;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
function val(name, def = "") {
  return String(process.env[name] ?? def).trim();
}
function normalizePem(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

const checks = [];
function pass(label, detail = "") {
  checks.push({ ok: true, label, detail });
}
function warn(label, detail = "") {
  checks.push({ ok: "warn", label, detail });
}
function fail(label, detail = "") {
  checks.push({ ok: false, label, detail });
}

const nodeEnv = val("NODE_ENV", "development");
const isProd = nodeEnv === "production";
const paymentsOn = flag("FEATURE_PAYMENTS_V2");
const provider = val("PAYMENTS_PROVIDER", "MOCK").toUpperCase();
const paymentsEnv = val("PAYMENTS_ENVIRONMENT", "SANDBOX").toUpperCase();
const myposEnv = val("MYPOS_ENVIRONMENT", "TEST").toUpperCase();
const mobileCurrency = val("MYPOS_MOBILE_CURRENCY", "GBP").toUpperCase();
const requireRef = String(val("MYPOS_REQUIRE_TXN_REF", "true")).toLowerCase() !== "false";

const wallet = val("MYPOS_WALLET_NUMBER");
const sid = val("MYPOS_SID");
const keyIndex = val("MYPOS_KEY_INDEX", "1");
const privateKey = normalizePem(process.env.MYPOS_PRIVATE_KEY);
const publicCert = normalizePem(process.env.MYPOS_PUBLIC_CERT);

// --- Feature wiring ---
if (paymentsOn) pass("FEATURE_PAYMENTS_V2", "payments are ENABLED");
else warn("FEATURE_PAYMENTS_V2", "payments are OFF — the app will show wallet/entry as unavailable");

if (provider === "MYPOS") pass("PAYMENTS_PROVIDER", "MYPOS");
else if (provider === "MOCK") warn("PAYMENTS_PROVIDER", "MOCK — no real card processing");
else warn("PAYMENTS_PROVIDER", provider);

// --- The production safety boot-guard (mirrors assertPaymentsSafeForEnv) ---
if ((isProd || paymentsEnv === "PRODUCTION") && paymentsOn && provider === "MOCK") {
  fail(
    "BOOT GUARD",
    "prod + FEATURE_PAYMENTS_V2 + MOCK provider → the server will REFUSE to boot. Set a real provider."
  );
} else {
  pass("BOOT GUARD", "config will not be blocked by the MOCK-in-prod guard");
}

// --- Credentials ---
if (provider === "MYPOS") {
  wallet ? pass("MYPOS_WALLET_NUMBER", "set") : fail("MYPOS_WALLET_NUMBER", "missing");
  sid ? pass("MYPOS_SID", "set") : fail("MYPOS_SID", "missing");
  keyIndex ? pass("MYPOS_KEY_INDEX", keyIndex) : fail("MYPOS_KEY_INDEX", "missing");

  if (privateKey) {
    try {
      createPrivateKey(privateKey);
      pass("MYPOS_PRIVATE_KEY", "parses as a valid RSA private key");
    } catch (e) {
      fail("MYPOS_PRIVATE_KEY", `present but will not parse: ${e.message}`);
    }
  } else {
    fail("MYPOS_PRIVATE_KEY", "missing — signing will fail");
  }

  if (publicCert) {
    try {
      createPublicKey(publicCert);
      pass("MYPOS_PUBLIC_CERT", "parses as a valid public certificate");
    } catch (e) {
      warn("MYPOS_PUBLIC_CERT", `present but will not parse: ${e.message}`);
    }
  } else {
    warn("MYPOS_PUBLIC_CERT", "missing — IPN signature verification unavailable");
  }
}

// --- Environment coherence ---
if (myposEnv === "PRODUCTION") pass("MYPOS_ENVIRONMENT", "PRODUCTION (live gateway)");
else warn("MYPOS_ENVIRONMENT", `${myposEnv} — SANDBOX gateway; CANNOT take real money`);

// The single most common go-live trap: live app pointed at a sandbox store.
if (isProd && myposEnv !== "PRODUCTION") {
  fail(
    "LIVE-vs-SANDBOX",
    "NODE_ENV=production but MYPOS_ENVIRONMENT is not PRODUCTION — real cards will be declined by the test gateway"
  );
}

pass("MYPOS_MOBILE_CURRENCY", `${mobileCurrency} — MUST equal your myPOS store currency`);
requireRef
  ? pass("MYPOS_REQUIRE_TXN_REF", "on — a gateway reference is required before settling")
  : warn("MYPOS_REQUIRE_TXN_REF", "off — settlement won't require a gateway reference (testing only)");

// --- Report ---
console.log("\nmyPOS go-live preflight\n" + "-".repeat(40));
console.log(`  NODE_ENV: ${nodeEnv}   PAYMENTS_ENVIRONMENT: ${paymentsEnv}\n`);
for (const c of checks) {
  const mark = c.ok === true ? "PASS" : c.ok === "warn" ? "WARN" : "FAIL";
  console.log(`  [${mark}] ${c.label}${c.detail ? " — " + c.detail : ""}`);
}
const fails = checks.filter((c) => c.ok === false).length;
const warns = checks.filter((c) => c.ok === "warn").length;
console.log("-".repeat(40));
console.log(`  ${fails} blocking, ${warns} warnings\n`);

if (fails > 0) {
  console.log("  → NOT ready: resolve the FAIL items above.\n");
  process.exitCode = 1;
} else if (warns > 0) {
  console.log("  → Config is valid. Review WARN items before taking REAL money.\n");
} else {
  console.log("  → Ready for live myPOS payments.\n");
}
