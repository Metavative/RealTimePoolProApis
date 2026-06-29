import assert from "node:assert/strict";

import { sign, verify } from "../src/services/jwtService.js";
import { generateOtp } from "../src/services/OTPService.js";
import {
  isPlatformAdmin,
  isLegacyAdminLike,
  hasPlatformAdminAccess,
  isAssignableRole,
} from "../src/utils/authz.js";
import {
  normalizeSortBy,
  resolveMoneyEarned,
  compareByScore,
  compareByMoney,
  makeLeaderboardComparator,
} from "../src/controllers/userController.js";
import {
  availableBalanceToMinor,
  classifyWalletDelta,
  summarizeReconciliation,
  isReconciliationSafeToBackfill,
} from "../src/utils/walletReconciliation.js";
import { createMockPaymentProvider } from "../src/services/payments/providers/mock.provider.js";
import { createMyPosPaymentProvider } from "../src/services/payments/providers/mypos.provider.js";
import {
  generateDoubleElim,
  progressDoubleElimination,
} from "../src/services/tournament.service.js";
import { summarizeDisputeTrends } from "../src/utils/disputeAnalytics.js";

// Tiny fixture helper for ranking tests.
function mkUser(id, { score = 0, winnings = 0, career, total, gamesWon = 0, name } = {}) {
  return {
    _id: id,
    username: name || id,
    profile: { nickname: name || id },
    stats: { score, totalWinnings: winnings, gamesWon },
    earnings: { career: career ?? 0, total: total ?? 0 },
  };
}

function rankedIds(users, sortBy) {
  return [...users].sort(makeLeaderboardComparator(sortBy)).map((u) => u._id);
}

let failures = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(e);
  }
}

await runTest("jwtService sign/verify roundtrip", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  process.env.JWT_EXPIRES = "1h";

  const token = sign({ id: "user_123", role: "USER" });
  assert.equal(typeof token, "string");
  assert.ok(token.length > 20);

  const payload = verify(token);
  assert.equal(payload.id, "user_123");
  assert.equal(payload.role, "USER");
});

await runTest("jwtService verify rejects invalid token", () => {
  process.env.JWT_SECRET = "test_secret_for_jwt_service";
  assert.throws(() => verify("invalid.token.value"));
});

await runTest("generateOtp default length is 6 digits", () => {
  const otp = generateOtp();
  assert.equal(otp.length, 6);
  assert.match(otp, /^\d{6}$/);
});

await runTest("generateOtp respects requested length", () => {
  const otp = generateOtp(8);
  assert.equal(otp.length, 8);
  assert.match(otp, /^\d{8}$/);
});

// ---- Phase 0: authorization hardening ----

await runTest("authz: venue_owner is NOT a platform admin", () => {
  const user = { profile: { role: "VENUE_OWNER", userType: "VENUE_OWNER" } };
  assert.equal(isPlatformAdmin(user), false);
  // Strict mode (default) must block it even though legacy logic would allow.
  delete process.env.AUTHZ_STRICT_ADMIN;
  assert.equal(isLegacyAdminLike(user), true);
  assert.equal(hasPlatformAdminAccess(user), false);
});

await runTest("authz: explicit admin signal grants access", () => {
  assert.equal(isPlatformAdmin({ profile: { isPlatformAdmin: true } }), true);
  assert.equal(isPlatformAdmin({ profile: { role: "admin" } }), true);
  assert.equal(isPlatformAdmin({ profile: { role: "club_administrator" } }), false);
});

await runTest("authz: AUTHZ_STRICT_ADMIN=false restores legacy behaviour", () => {
  process.env.AUTHZ_STRICT_ADMIN = "false";
  assert.equal(hasPlatformAdminAccess({ profile: { role: "organizer" } }), true);
  delete process.env.AUTHZ_STRICT_ADMIN;
});

await runTest("authz: role assignment allow-list excludes admin roles", () => {
  assert.equal(isAssignableRole("player"), true);
  assert.equal(isAssignableRole("venue_owner"), true);
  assert.equal(isAssignableRole("admin"), false);
  assert.equal(isAssignableRole("super_admin"), false);
});

// ---- Phase A: money-based ranking ----

await runTest("ranking: sortBy defaults to score, accepts money aliases", () => {
  assert.equal(normalizeSortBy(undefined), "score");
  assert.equal(normalizeSortBy(""), "score");
  assert.equal(normalizeSortBy("score"), "score");
  assert.equal(normalizeSortBy("anything-else"), "score");
  assert.equal(normalizeSortBy("money"), "money");
  assert.equal(normalizeSortBy("winnings"), "money");
  assert.equal(normalizeSortBy("earnings"), "money");
  assert.equal(normalizeSortBy("PRIZE_MONEY"), "money");
});

await runTest("ranking: resolveMoneyEarned prefers highest money source, never negative", () => {
  assert.equal(resolveMoneyEarned({}), 0);
  assert.equal(resolveMoneyEarned({ stats: { totalWinnings: 500 } }), 500);
  assert.equal(
    resolveMoneyEarned({ stats: { totalWinnings: 100 }, earnings: { career: 900 } }),
    900
  );
  assert.equal(resolveMoneyEarned({ earnings: { total: 250 } }), 250);
  assert.equal(resolveMoneyEarned({ stats: { totalWinnings: -50 } }), 0);
  assert.equal(resolveMoneyEarned({ stats: { totalWinnings: "abc" } }), 0);
});

await runTest("ranking: default (score) order is unchanged by money fields", () => {
  // Legacy ordering: score desc, then totalWinnings, then gamesWon, then name.
  const users = [
    mkUser("low-score-rich", { score: 10, winnings: 9999, career: 9999, total: 9999 }),
    mkUser("high-score-poor", { score: 100, winnings: 1 }),
    mkUser("mid-score", { score: 50, winnings: 50 }),
  ];
  assert.deepEqual(rankedIds(users, "score"), [
    "high-score-poor",
    "mid-score",
    "low-score-rich",
  ]);
  // Unknown/absent sortBy must behave exactly like score mode.
  assert.deepEqual(rankedIds(users, undefined), rankedIds(users, "score"));
});

await runTest("ranking: money mode orders by money earned, then score", () => {
  const users = [
    mkUser("high-score-poor", { score: 100, winnings: 1 }),
    mkUser("low-score-rich", { score: 10, winnings: 9999 }),
    mkUser("mid", { score: 50, winnings: 500 }),
  ];
  assert.deepEqual(rankedIds(users, "money"), [
    "low-score-rich",
    "mid",
    "high-score-poor",
  ]);
});

await runTest("ranking: referral-heavy user (career > totalWinnings) ranks on real earned money", () => {
  // totalWinnings is only match winnings; referral money lives in career/total.
  const referralEarner = mkUser("referral-earner", { score: 20, winnings: 100, career: 5000, total: 5000 });
  const matchEarner = mkUser("match-earner", { score: 20, winnings: 1000, career: 1000, total: 1000 });
  // Money mode must rank the referral earner first (5000 > 1000)...
  assert.deepEqual(rankedIds([matchEarner, referralEarner], "money"), [
    "referral-earner",
    "match-earner",
  ]);
  // ...even though by totalWinnings alone the match earner looks richer.
  assert.equal(resolveMoneyEarned(referralEarner), 5000);
  assert.equal(resolveMoneyEarned(matchEarner), 1000);
});

await runTest("ranking: fully-tied users get a stable, request-independent order", () => {
  const a = mkUser("aaa", { score: 5, winnings: 5 });
  const b = mkUser("bbb", { score: 5, winnings: 5 });
  const c = mkUser("ccc", { score: 5, winnings: 5 });
  // Same order regardless of input permutation (id tiebreak guarantees it).
  assert.deepEqual(rankedIds([c, a, b], "money"), rankedIds([b, c, a], "money"));
  assert.deepEqual(rankedIds([c, a, b], "score"), ["aaa", "bbb", "ccc"]);
});

await runTest("ranking: makeLeaderboardComparator selects the right comparator", () => {
  assert.equal(makeLeaderboardComparator("money"), compareByMoney);
  assert.equal(makeLeaderboardComparator("score"), compareByScore);
  assert.equal(makeLeaderboardComparator(undefined), compareByScore);
});

// ---- Phase B1: tournament discovery view ----

const { buildDiscoveryView } = await import(
  "../src/controllers/tournamentInvite.controller.js"
);

await runTest("discovery: unlimited capacity is joinable when not already in", () => {
  const v = buildDiscoveryView(
    { _id: "t1", title: "Open Cup", maxPlayers: 0, entrants: [{ entrantId: "x" }] },
    "viewer1"
  );
  assert.equal(v.maxPlayers, 0);
  assert.equal(v.isFull, false);
  assert.equal(v.alreadyJoined, false);
  assert.equal(v.joinable, true);
  assert.equal(v.entrantCount, 1);
});

await runTest("discovery: full tournament is not joinable", () => {
  const v = buildDiscoveryView(
    { _id: "t2", maxPlayers: 2, entrants: [{ entrantId: "a" }, { entrantId: "b" }] },
    "viewer1"
  );
  assert.equal(v.isFull, true);
  assert.equal(v.joinable, false);
});

await runTest("discovery: already-joined viewer is flagged and not joinable", () => {
  const v = buildDiscoveryView(
    { _id: "t3", maxPlayers: 8, entrants: [{ entrantId: "viewer1" }] },
    "viewer1"
  );
  assert.equal(v.alreadyJoined, true);
  assert.equal(v.joinable, false);
});

await runTest("discovery: entry fee is surfaced only when economy enabled", () => {
  const paid = buildDiscoveryView(
    { _id: "t4", economy: { enabled: true, currency: "GBP", entryFeeMinor: 500 }, entrants: [] },
    "viewer1"
  );
  assert.deepEqual(paid.entryFee, { enabled: true, currency: "GBP", amountMinor: 500 });
  const free = buildDiscoveryView({ _id: "t5", economy: { enabled: false }, entrants: [] }, "viewer1");
  assert.deepEqual(free.entryFee, { enabled: false });
});

// ---- Phase B2: live scoring authority + payload ----

const { buildScoreUpdate, authorizeScorePush } = await import(
  "../src/services/socket_handler/matchLiveHandler.js"
);

// Fake Match model whose findById(...).select(...).lean() resolves to a fixture.
function fakeMatchModel(doc) {
  return {
    findById() {
      return {
        select() {
          return { lean: async () => doc };
        },
      };
    },
  };
}
const authOff = () => false;
const authOn = () => true;
const validId = () => true;
const invalidId = () => false;

await runTest("live score: payload is sanitized (numbers, capped note, attribution)", () => {
  const u = buildScoreUpdate(
    { matchId: "m1", scoreA: "3", scoreB: 2, frame: 4, note: "x".repeat(500) },
    "user9",
    1234
  );
  assert.equal(u.matchId, "m1");
  assert.equal(u.scoreA, 3);
  assert.equal(u.scoreB, 2);
  assert.equal(u.frame, 4);
  assert.equal(u.note.length, 200);
  assert.equal(u.by, "user9");
  assert.equal(u.at, 1234);
  // Non-numeric scores become null, not NaN.
  assert.equal(buildScoreUpdate({ scoreA: "abc" }).scoreA, null);
});

await runTest("live score: participant of a 1v1 match is authorized", async () => {
  const deps = {
    socketAuthRequired: authOn,
    isValidObjectId: validId,
    Match: fakeMatchModel({ players: ["userA", "userB"] }),
  };
  assert.deepEqual(await authorizeScorePush("abc", "userA", deps), { ok: true });
});

await runTest("live score: non-participant is rejected", async () => {
  const deps = {
    socketAuthRequired: authOn,
    isValidObjectId: validId,
    Match: fakeMatchModel({ players: ["userA", "userB"] }),
  };
  const v = await authorizeScorePush("abc", "intruder", deps);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "NOT_PARTICIPANT");
});

await runTest("live score: unknown 1v1 match is rejected", async () => {
  const deps = {
    socketAuthRequired: authOn,
    isValidObjectId: validId,
    Match: fakeMatchModel(null),
  };
  const v = await authorizeScorePush("abc", "userA", deps);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "MATCH_NOT_FOUND");
});

await runTest("live score: anonymous push blocked when auth required, allowed in soft mode", async () => {
  const depsRequired = { socketAuthRequired: authOn, isValidObjectId: validId, Match: fakeMatchModel(null) };
  const depsSoft = { socketAuthRequired: authOff, isValidObjectId: validId, Match: fakeMatchModel(null) };
  assert.equal((await authorizeScorePush("abc", "", depsRequired)).ok, false);
  assert.equal((await authorizeScorePush("abc", "", depsSoft)).ok, true);
});

await runTest("live score: tournament/custom match id requires only authentication", async () => {
  const deps = { socketAuthRequired: authOn, isValidObjectId: invalidId, Match: fakeMatchModel(null) };
  // Authenticated sender, non-ObjectId id (e.g. "po_r1_1") → allowed (advisory).
  assert.deepEqual(await authorizeScorePush("po_r1_1", "userA", deps), { ok: true });
});

// ---- Phase B money sub-phase: tournament prize distribution ----

const {
  computePrizePoolMinor,
  resolvePrizeWinners,
  computePayouts,
} = await import("../src/services/tournamentPayout.service.js");

await runTest("payout: prize pool sums only PAID orders' prizePoolMinor", () => {
  const orders = [
    { status: "PAID", prizePoolMinor: 250 },
    { status: "PAID", prizePoolMinor: 250 },
    { status: "PENDING_PAYMENT", prizePoolMinor: 250 },
    { status: "REFUNDED", prizePoolMinor: 250 },
    { status: "PAID", prizePoolMinor: -5 }, // clamped to 0
  ];
  assert.equal(computePrizePoolMinor(orders), 500);
  assert.equal(computePrizePoolMinor([]), 0);
});

await runTest("payout: champion resolves to a payable user", () => {
  const t = {
    championName: "uid:winner1",
    entrants: [
      { participantKey: "uid:winner1", entrantId: "winner1", isLocal: false },
      { participantKey: "uid:loser2", entrantId: "loser2", isLocal: false },
    ],
  };
  const winners = resolvePrizeWinners(t, 1);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].userId, "winner1");
  assert.equal(winners[0].placement, 1);
  assert.equal(winners[0].isLocal, false);
});

await runTest("payout: local/non-user champion is not payable", () => {
  const t = {
    championName: "nm:Guest:123",
    entrants: [{ participantKey: "nm:Guest:123", isLocal: true }],
  };
  const winners = resolvePrizeWinners(t, 1);
  assert.equal(winners[0].userId, "");
  assert.equal(winners[0].isLocal, true);
});

await runTest("payout: no champion yields no winners", () => {
  assert.deepEqual(resolvePrizeWinners({ championName: "", entrants: [] }, 1), []);
});

await runTest("payout: champion-takes-all gets the whole pool incl. remainder", () => {
  const winners = [{ userId: "w1", participantKey: "uid:w1", placement: 1 }];
  const payouts = computePayouts(501, winners, [10000]);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].amountMinor, 501);
});

await runTest("payout: split with rounding remainder goes to first place", () => {
  const winners = [
    { userId: "w1", participantKey: "uid:w1", placement: 1 },
    { userId: "w2", participantKey: "uid:w2", placement: 2 },
  ];
  // 70/30 of 101 = 70 + 30 = 100, remainder 1 -> first place => 71 + 30.
  const payouts = computePayouts(101, winners, [7000, 3000]);
  assert.equal(payouts[0].amountMinor + payouts[1].amountMinor, 101);
  assert.equal(payouts[0].amountMinor, 71);
  assert.equal(payouts[1].amountMinor, 30);
});

await runTest("payout: empty pool or no payable winner yields no payouts", () => {
  assert.deepEqual(computePayouts(0, [{ userId: "w1" }]), []);
  assert.deepEqual(computePayouts(500, [{ userId: "" }]), []);
});

// ---- Phase C: webhook hardening ----

import crypto from "node:crypto";
const {
  verifyWebhookSignature,
  isKnownWebhookProvider,
  mockWebhookBypassAllowed,
} = await import("../src/controllers/payments.controller.js");

function hmac(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}
function clearWebhookEnv() {
  delete process.env.PAYMENTS_WEBHOOK_SECRET;
  delete process.env.MYPOS_WEBHOOK_SECRET;
  delete process.env.PAYMENTS_ENVIRONMENT;
  delete process.env.NODE_ENV;
  delete process.env.ALLOW_MOCK_WEBHOOKS;
  delete process.env.WEBHOOK_PROVIDERS;
}

await runTest("webhook: only known providers are accepted", () => {
  clearWebhookEnv();
  assert.equal(isKnownWebhookProvider("MOCK"), true);
  assert.equal(isKnownWebhookProvider("mypos"), true);
  assert.equal(isKnownWebhookProvider("EVILCORP"), false);
  process.env.WEBHOOK_PROVIDERS = "stripe, adyen";
  assert.equal(isKnownWebhookProvider("STRIPE"), true);
  clearWebhookEnv();
});

await runTest("webhook: MOCK signature bypass blocked in production, allowed in sandbox", () => {
  clearWebhookEnv();
  assert.equal(mockWebhookBypassAllowed(), true); // no env => non-prod
  process.env.PAYMENTS_ENVIRONMENT = "PRODUCTION";
  assert.equal(mockWebhookBypassAllowed(), false);
  process.env.ALLOW_MOCK_WEBHOOKS = "true";
  assert.equal(mockWebhookBypassAllowed(), true); // explicit override
  clearWebhookEnv();
});

await runTest("webhook: unsigned MOCK is verified in sandbox but rejected in production", () => {
  clearWebhookEnv();
  const sandbox = verifyWebhookSignature({ provider: "MOCK", payload: { status: "PAID" }, signature: "" });
  assert.equal(sandbox.verified, true);
  process.env.PAYMENTS_ENVIRONMENT = "PRODUCTION";
  const prod = verifyWebhookSignature({ provider: "MOCK", payload: { status: "PAID" }, signature: "" });
  assert.equal(prod.verified, false);
  assert.equal(prod.reason, "mock_bypass_disabled_in_production");
  clearWebhookEnv();
});

await runTest("webhook: HMAC verifies the exact raw body, rejects tampering", () => {
  clearWebhookEnv();
  process.env.PAYMENTS_WEBHOOK_SECRET = "shh";
  const raw = '{"intentId":"X","status":"PAID"}';
  const good = verifyWebhookSignature({
    provider: "MYPOS",
    payload: JSON.parse(raw),
    rawBody: raw,
    signature: hmac("shh", raw),
  });
  assert.equal(good.verified, true);
  const bad = verifyWebhookSignature({
    provider: "MYPOS",
    payload: JSON.parse(raw),
    rawBody: raw,
    signature: hmac("shh", '{"intentId":"X","status":"FAILED"}'),
  });
  assert.equal(bad.verified, false);
  clearWebhookEnv();
});

await runTest("webhook: canonical-form signature still verifies (backward compat)", () => {
  clearWebhookEnv();
  process.env.PAYMENTS_WEBHOOK_SECRET = "shh";
  // raw has unsorted keys; legacy signer signed the canonical (sorted) form.
  const raw = '{"status":"PAID","amount":5}';
  const canonical = '{"amount":5,"status":"PAID"}';
  const res = verifyWebhookSignature({
    provider: "MYPOS",
    payload: { status: "PAID", amount: 5 },
    rawBody: raw,
    signature: hmac("shh", canonical),
  });
  assert.equal(res.verified, true);
  clearWebhookEnv();
});

// ---- Phase C2: tournament entry refunds ----

const { reverseLedgerLines } = await import("../src/controllers/payments.controller.js");
const { tournamentEntryRefundEligibility } = await import(
  "../src/controllers/tournamentEconomy.controller.js"
);

await runTest("refund: reverseLedgerLines flips direction and stays balanced", () => {
  const settlement = [
    { direction: "DEBIT", accountType: "SYSTEM_ADJUSTMENT", accountId: "EXTERNAL_GATEWAY_IN", amountMinor: 1000 },
    { direction: "CREDIT", accountType: "ORGANIZER_BALANCE", accountId: "ORG1", amountMinor: 500 },
    { direction: "CREDIT", accountType: "PRIZE_POOL", accountId: "PRIZE_TOURN_X", amountMinor: 500 },
  ];
  const reversed = reverseLedgerLines(settlement);
  assert.equal(reversed[0].direction, "CREDIT");
  assert.equal(reversed[1].direction, "DEBIT");
  assert.equal(reversed[2].direction, "DEBIT");
  // account/amount unchanged
  assert.equal(reversed[0].accountId, "EXTERNAL_GATEWAY_IN");
  assert.equal(reversed[2].amountMinor, 500);
  // balanced: debits == credits in both directions
  const sum = (arr, dir) =>
    arr.filter((l) => l.direction === dir).reduce((a, l) => a + l.amountMinor, 0);
  assert.equal(sum(reversed, "DEBIT"), sum(reversed, "CREDIT"));
  // double-reverse returns to original directions
  const back = reverseLedgerLines(reversed);
  assert.equal(back[0].direction, "DEBIT");
});

await runTest("refund: eligibility allows paid+not-started, blocks started/unpaid/refunded", () => {
  assert.deepEqual(
    tournamentEntryRefundEligibility({ status: "PAID" }, { status: "DRAFT" }),
    { ok: true }
  );
  assert.equal(
    tournamentEntryRefundEligibility({ status: "PAID" }, { status: "ACTIVE" }).code,
    "TOURNAMENT_STARTED"
  );
  assert.equal(
    tournamentEntryRefundEligibility({ status: "PAID" }, { status: "COMPLETED" }).code,
    "TOURNAMENT_STARTED"
  );
  assert.equal(
    tournamentEntryRefundEligibility({ status: "PENDING_PAYMENT" }, { status: "DRAFT" }).code,
    "ORDER_NOT_PAID"
  );
  const already = tournamentEntryRefundEligibility({ status: "REFUNDED" }, { status: "DRAFT" });
  assert.equal(already.code, "ALREADY_REFUNDED");
  assert.equal(already.idempotent, true);
});

// ---- Phase C: transaction (replica-set) guard ----

const { transactionsAvailable, requireTransactions } = await import(
  "../src/utils/dbTransactions.js"
);
function txRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

await runTest("tx guard: refuses with 503 when transactions unsupported", () => {
  delete process.env.TX_ASSUME_SUPPORTED;
  // Not connected to a replica set in tests => unsupported.
  assert.equal(transactionsAvailable(), false);
  const res = txRes();
  const ok = requireTransactions(res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "TRANSACTIONS_REQUIRED");
});

await runTest("tx guard: TX_ASSUME_SUPPORTED escape hatch allows the flow", () => {
  process.env.TX_ASSUME_SUPPORTED = "true";
  assert.equal(transactionsAvailable(), true);
  const res = txRes();
  assert.equal(requireTransactions(res), true);
  assert.equal(res.statusCode, 200); // untouched
  delete process.env.TX_ASSUME_SUPPORTED;
});

// ---- Phase D: dashboard aggregation helpers ----

const { summarizeLedgerByAccountType, platformFinanceFromLedger, countByKey } =
  await import("../src/utils/ledgerSummary.js");

await runTest("dashboard: ledger summary computes balance = credit - debit per type", () => {
  const rows = [
    { _id: "PLATFORM_REVENUE", debitMinor: 0, creditMinor: 1500 },
    { _id: "USER_WALLET", debitMinor: 800, creditMinor: 1000 },
    { _id: "prize_pool", debitMinor: 100, creditMinor: 600 }, // lower-cased key normalises
  ];
  const byType = summarizeLedgerByAccountType(rows);
  assert.equal(byType.PLATFORM_REVENUE.balanceMinor, 1500);
  assert.equal(byType.USER_WALLET.balanceMinor, 200);
  assert.equal(byType.PRIZE_POOL.balanceMinor, 500);
  assert.deepEqual(summarizeLedgerByAccountType([]), {});
});

await runTest("dashboard: platform finance pulls the right account balances", () => {
  const byType = summarizeLedgerByAccountType([
    { _id: "PLATFORM_REVENUE", creditMinor: 1500, debitMinor: 0 },
    { _id: "PRIZE_POOL", creditMinor: 600, debitMinor: 100 },
    { _id: "ORGANIZER_BALANCE", creditMinor: 900, debitMinor: 200 },
  ]);
  const f = platformFinanceFromLedger(byType);
  assert.equal(f.platformRevenueMinor, 1500);
  assert.equal(f.prizePoolHeldMinor, 500);
  assert.equal(f.organizerBalancesMinor, 700);
  assert.equal(f.userWalletsMinor, 0); // absent type => 0
});

await runTest("dashboard: countByKey totals status breakdowns", () => {
  const { byStatus, total } = countByKey([
    { _id: "DRAFT", count: 3 },
    { _id: "active", count: 2 },
    { _id: null, count: 1 },
  ]);
  assert.equal(byStatus.DRAFT, 3);
  assert.equal(byStatus.ACTIVE, 2);
  assert.equal(byStatus.UNKNOWN, 1);
  assert.equal(total, 6);
});

// =====================================================================
// U0 — wallet reconciliation (ledger↔earnings unification)
// =====================================================================

await runTest("U0: availableBalanceToMinor converts pounds→pence with rounding", () => {
  assert.equal(availableBalanceToMinor(0), 0);
  assert.equal(availableBalanceToMinor(12.34), 1234);
  assert.equal(availableBalanceToMinor(0.1), 10);
  assert.equal(availableBalanceToMinor("5"), 500);
  assert.equal(availableBalanceToMinor(undefined), 0);
  assert.equal(availableBalanceToMinor("nope"), 0);
});

await runTest("U0: classify IN_SYNC when available equals ledger", () => {
  const r = classifyWalletDelta({ availableMinor: 1000, ledgerMinor: 1000 });
  assert.equal(r.status, "IN_SYNC");
  assert.equal(r.deltaMinor, 0);
});

await runTest("U0: classify MATCH_WINNINGS_NOT_IN_LEDGER when available ahead", () => {
  const r = classifyWalletDelta({ availableMinor: 5000, ledgerMinor: 1000 });
  assert.equal(r.status, "MATCH_WINNINGS_NOT_IN_LEDGER");
  assert.equal(r.deltaMinor, 4000);
});

await runTest("U0: classify LEDGER_AHEAD when ledger ahead", () => {
  const r = classifyWalletDelta({ availableMinor: 1000, ledgerMinor: 2500 });
  assert.equal(r.status, "LEDGER_AHEAD");
  assert.equal(r.deltaMinor, -1500);
});

await runTest("U0: classify UNEXPLAINED on a negative balance", () => {
  assert.equal(classifyWalletDelta({ availableMinor: -100, ledgerMinor: 0 }).status, "UNEXPLAINED");
  assert.equal(classifyWalletDelta({ availableMinor: 0, ledgerMinor: -100 }).status, "UNEXPLAINED");
});

await runTest("U0: tolerance absorbs sub-penny drift", () => {
  const r = classifyWalletDelta({ availableMinor: 1001, ledgerMinor: 1000, toleranceMinor: 1 });
  assert.equal(r.status, "IN_SYNC");
});

await runTest("U0: summarize totals deltas, gap and backfill credit", () => {
  const rows = [
    { status: "IN_SYNC", deltaMinor: 0 },
    { status: "MATCH_WINNINGS_NOT_IN_LEDGER", deltaMinor: 4000 },
    { status: "MATCH_WINNINGS_NOT_IN_LEDGER", deltaMinor: 1000 },
    { status: "LEDGER_AHEAD", deltaMinor: -1500 },
  ];
  const s = summarizeReconciliation(rows);
  assert.equal(s.users, 4);
  assert.equal(s.byStatus.IN_SYNC, 1);
  assert.equal(s.byStatus.MATCH_WINNINGS_NOT_IN_LEDGER, 2);
  assert.equal(s.byStatus.LEDGER_AHEAD, 1);
  assert.equal(s.netDeltaMinor, 3500);
  assert.equal(s.absDeltaMinor, 6500);
  assert.equal(s.backfillCreditMinor, 5000);
});

await runTest("U0: safe-to-backfill is false when any UNEXPLAINED present", () => {
  const safe = summarizeReconciliation([{ status: "IN_SYNC", deltaMinor: 0 }]);
  const unsafe = summarizeReconciliation([{ status: "UNEXPLAINED", deltaMinor: 50 }]);
  assert.equal(isReconciliationSafeToBackfill(safe), true);
  assert.equal(isReconciliationSafeToBackfill(unsafe), false);
});

// ---- Provider refunds (real gateway refund of a charge) ----

await runTest("mock provider: refundPayment returns a REFUNDED result keyed to the intent", async () => {
  const provider = createMockPaymentProvider();
  const result = await provider.refundPayment({
    intent: { intentId: "PAY_1", providerPaymentId: "MOCK_PAY_PAY_1", currency: "gbp" },
    amountMinor: 500,
    currency: "GBP",
    idempotencyKey: "REFUND_PAY_1",
  });
  assert.equal(result.status, "REFUNDED");
  // Idempotency key doubles as the refund id, so retries resolve to the same id.
  assert.equal(result.providerRefundId, "REFUND_PAY_1");
  assert.equal(result.amountMinor, 500);
  assert.equal(result.currency, "GBP");
  assert.equal(result.providerPaymentId, "MOCK_PAY_PAY_1");
});

await runTest("mock provider: refundPayment falls back to a synthetic id without a key", async () => {
  const provider = createMockPaymentProvider();
  const result = await provider.refundPayment({ intent: { intentId: "PAY_2" }, amountMinor: 0 });
  assert.equal(result.providerRefundId, "MOCK_REFUND_PAY_2");
  assert.equal(result.amountMinor, 0);
});

await runTest("mypos provider: refundPayment throws NOT_CONFIGURED until creds exist", async () => {
  // Ensure no myPOS config is present in the test env.
  for (const k of [
    "MYPOS_PARTNER_CLIENT_ID",
    "MYPOS_PARTNER_SECRET",
    "MYPOS_MERCHANT_CLIENT_ID",
    "MYPOS_MERCHANT_SECRET",
    "MYPOS_PARTNER_ID",
    "MYPOS_APPLICATION_ID",
  ]) {
    delete process.env[k];
  }
  const provider = createMyPosPaymentProvider();
  await assert.rejects(
    () => provider.refundPayment({ intent: { intentId: "PAY_3" }, amountMinor: 100 }),
    (err) => err.code === "MYPOS_NOT_CONFIGURED"
  );
});

// ---- Double elimination engine ----

// Build a double-elim tournament fixture for n players and return a fake `t`.
function mkDeTournament(n) {
  const keys = Array.from({ length: n }, (_, i) => `uid:${i + 1}`);
  const nameByKey = new Map(keys.map((k) => [k, `P${k.slice(4)}`]));
  const matches = generateDoubleElim(keys, "Table 1", nameByKey);
  const t = { matches, championName: "", entrants: keys.map((k) => ({ participantKey: k, name: nameByKey.get(k) })) };
  progressDoubleElimination(t);
  return { t, keys };
}

function deReady(m) {
  const real = (k) => k && !["BYE", "TBD"].includes(String(k).toUpperCase());
  return m.status !== "played" && real(m.teamA) && real(m.teamB);
}

// Play out the whole bracket; `pick(m)` returns "A" or "B" for the winner.
function dePlayOut(t, pick) {
  for (let guard = 0; guard < 1000; guard++) {
    const m = t.matches.find((x) => x.id.startsWith("de_") && deReady(x));
    if (!m) break;
    const win = pick(m); // "A" or "B"
    m.scoreA = win === "A" ? 1 : 0;
    m.scoreB = win === "B" ? 1 : 0;
    m.status = "played";
    progressDoubleElimination(t);
  }
}

await runTest("double-elim: bracket has the right shape (2S-1 matches, one WB final)", () => {
  for (const n of [2, 3, 4, 5, 8, 11, 16]) {
    const { t } = mkDeTournament(n);
    const S = (() => { let p = 1; while (p < n) p *= 2; return p; })();
    const de = t.matches.filter((m) => m.id.startsWith("de_"));
    assert.equal(de.length, 2 * S - 1, `n=${n}: expected ${2 * S - 1} matches`);
    assert.equal(de.filter((m) => m.id.startsWith("de_wb_")).length, S - 1, `n=${n}: WB count`);
    assert.equal(de.filter((m) => m.id.startsWith("de_lb_")).length, S - 2, `n=${n}: LB count`);
    assert.ok(de.find((m) => m.id === "de_gf_1") && de.find((m) => m.id === "de_gf_2"));
  }
});

await runTest("double-elim: WB side undefeated wins without a reset", () => {
  for (const n of [2, 3, 4, 5, 8, 11, 16]) {
    const { t, keys } = mkDeTournament(n);
    // teamA always wins -> the winners-bracket finalist never loses.
    dePlayOut(t, () => "A");
    assert.ok(t.championName, `n=${n}: a champion should be decided`);
    assert.ok(keys.includes(t.championName), `n=${n}: champion is a real entrant`);
    const gf2 = t.matches.find((m) => m.id === "de_gf_2");
    // No reset needed, so the reset game stays unplayed.
    assert.notEqual(gf2.status, "played", `n=${n}: no bracket reset expected`);
  }
});

await runTest("double-elim: losing the grand final forces a bracket reset", () => {
  const { t, keys } = mkDeTournament(8);
  // Play everything teamA-wins until only the grand final remains.
  for (let guard = 0; guard < 1000; guard++) {
    const m = t.matches.find((x) => x.id.startsWith("de_") && deReady(x));
    if (!m) break;
    if (m.id === "de_gf_1") break;
    m.scoreA = 1; m.scoreB = 0; m.status = "played";
    progressDoubleElimination(t);
  }
  const gf1 = t.matches.find((m) => m.id === "de_gf_1");
  assert.ok(deReady(gf1), "grand final should be ready");
  // The losers-bracket side (teamB) wins game 1 -> reset.
  gf1.scoreA = 0; gf1.scoreB = 1; gf1.status = "played";
  progressDoubleElimination(t);
  assert.equal(t.championName, "", "no champion yet — reset game pending");
  const gf2 = t.matches.find((m) => m.id === "de_gf_2");
  assert.ok(deReady(gf2), "reset game should be populated and ready");
  // Whoever wins the reset is champion.
  gf2.scoreA = 1; gf2.scoreB = 0; gf2.status = "played";
  progressDoubleElimination(t);
  assert.equal(t.championName, gf2.teamA, "reset winner is champion");
  assert.ok(keys.includes(t.championName));
});

await runTest("double-elim: editing an early result re-cascades the bracket", () => {
  const { t } = mkDeTournament(4);
  dePlayOut(t, () => "A");
  const championAllAWin = t.championName;
  // Now flip the very first winners-bracket match and replay.
  const wb1 = t.matches.find((m) => m.id === "de_wb_r1_1");
  wb1.scoreA = 0; wb1.scoreB = 1; wb1.status = "played";
  progressDoubleElimination(t);
  // Downstream WB slot must reflect the new winner (teamB of wb1), not stale.
  const wbFinal = t.matches.find((m) => m.id === "de_wb_r2_1");
  assert.ok(
    [wbFinal.teamA, wbFinal.teamB].includes(wb1.teamB),
    "edited winner propagates into the WB final"
  );
  // Finish again; a valid champion is still produced.
  dePlayOut(t, () => "A");
  assert.ok(t.championName, "champion decided after the edit");
});

// ---- Dispute-trend analytics ----

await runTest("disputeTrends: counts, rate, avg resolution time and series", () => {
  const now = new Date("2026-06-29T00:00:00.000Z").getTime();
  const day = 86400000;
  const cases = [
    // resolved 2 days after opening, 1 day ago
    {
      status: "RESOLVED",
      module: "MATCH",
      createdAt: new Date(now - 3 * day),
      claimedAmountMinor: 1000,
      resolution: { resolvedAt: new Date(now - 1 * day), decision: "REFUND", payoutAmountMinor: 1000 },
    },
    // still open, created 5 days ago
    { status: "OPEN", module: "TOURNAMENT", createdAt: new Date(now - 5 * day), claimedAmountMinor: 500 },
    // rejected (terminal, not resolved)
    { status: "REJECTED", module: "MATCH", createdAt: new Date(now - 2 * day), claimedAmountMinor: 200 },
  ];

  const s = summarizeDisputeTrends(cases, { now, windowDays: 30 });
  assert.equal(s.total, 3);
  assert.equal(s.open, 1, "only the OPEN case is non-terminal");
  assert.equal(s.resolved, 1);
  assert.equal(s.byStatus.RESOLVED, 1);
  assert.equal(s.byStatus.OPEN, 1);
  assert.equal(s.byStatus.REJECTED, 1);
  assert.equal(s.byModule.MATCH, 2);
  assert.equal(s.byDecision.REFUND, 1);
  assert.equal(s.claimedMinorTotal, 1700);
  assert.equal(s.payoutMinorTotal, 1000);
  assert.equal(s.resolutionRatePct, 33.3, "1 of 3 resolved");
  assert.equal(s.avgResolutionHours, 48, "resolved 2 days after opening");
  assert.equal(s.series.length, 30);
  // series newest-last; the last day is "now".
  assert.equal(s.series[s.series.length - 1].date, "2026-06-29");
  const opened = s.series.reduce((acc, d) => acc + d.opened, 0);
  assert.equal(opened, 3, "all three opened within the window");
  const resolvedInSeries = s.series.reduce((acc, d) => acc + d.resolved, 0);
  assert.equal(resolvedInSeries, 1);
});

await runTest("disputeTrends: empty input yields zeroed summary with a full series", () => {
  const now = new Date("2026-06-29T00:00:00.000Z").getTime();
  const s = summarizeDisputeTrends([], { now, windowDays: 7 });
  assert.equal(s.total, 0);
  assert.equal(s.resolutionRatePct, 0);
  assert.equal(s.avgResolutionHours, null);
  assert.equal(s.series.length, 7);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}

console.log("\nAll tests passed.");

