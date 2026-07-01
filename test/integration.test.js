// Integration tests for Phases A & B against an ephemeral in-memory MongoDB.
//
// Runs the REAL controllers/services/models (not mocks) so the DB-touching
// behaviour — discovery filtering, capacity race guard, safe-leave, money
// ranking, and idempotent prize settlement — is actually verified.
//
// Requires the dev-only `mongodb-memory-server`. If it (or its mongod binary)
// is unavailable, the suite SKIPS cleanly rather than failing.
//
// Run: node ./test/integration.test.js

import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.JWT_SECRET = process.env.JWT_SECRET || "integration_test_secret";

// Where to run the integration tests:
//   1. TEST_MONGO_URI=<uri>  -> run against a real DB you provide (Docker replica
//      set, a local replica set, or an ISOLATED Atlas test db). Required to
//      validate the transaction-using money flows. We always use a dedicated
//      `poolpro_integration_test` database and wipe it, so your real data is
//      never touched.
//   2. otherwise            -> spin up an ephemeral in-memory mongod (needs the
//      `mongodb-memory-server` dev dep + its mongod binary, which on Windows
//      needs the VC++ redistributable). In-memory mode is standalone, so the
//      transaction flows still require option 1.
const TEST_URI = process.env.TEST_MONGO_URI || process.env.MONGO_TEST_URI || "";
const TEST_DB_NAME = "poolpro_integration_test";

let mongod = null;
let uri = TEST_URI;

if (!uri) {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
  } catch {
    console.log("SKIP integration tests: set TEST_MONGO_URI, or install mongodb-memory-server.");
    process.exit(0);
  }
  try {
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri();
  } catch (e) {
    console.log("SKIP integration tests: no TEST_MONGO_URI and in-memory mongod failed:", e?.message || e);
    process.exit(0);
  }
}

await mongoose.connect(uri, { dbName: TEST_DB_NAME });
// Start from a clean, isolated test database (safe: only the dedicated test db).
await mongoose.connection.dropDatabase().catch(() => {});

const User = (await import("../src/models/user.model.js")).default;
const Tournament = (await import("../src/models/tournament.model.js")).default;
const TournamentEntryOrder = (await import("../src/models/tournamentEntryOrder.model.js")).default;
const { leaderboard } = await import("../src/controllers/userController.js");
const {
  discoverTournaments,
  joinTournamentOpen,
  leaveTournamentOpen,
} = await import("../src/controllers/tournamentInvite.controller.js");
const { settleTournamentPrizes } = await import(
  "../src/services/tournamentPayout.service.js"
);
const {
  creditUserWallet,
  getUserWalletBalanceMinor,
  getSpendableBalanceMinor,
} = await import("../src/services/ledgerUnification.service.js");
const { refundTournamentEntry } = await import(
  "../src/controllers/tournamentEconomy.controller.js"
);
const {
  requestOrganizerPayout,
  listOrganizerPayouts,
  requestWalletWithdrawal,
  adminCompletePayout,
  adminFailPayout,
  adminListPayouts,
} = await import("../src/controllers/payments.controller.js");
const LedgerEntry = (await import("../src/models/ledgerEntry.model.js")).default;
const PaymentIntent = (await import("../src/models/paymentIntent.model.js")).default;
const { dashboard } = await import("../src/controllers/userController.js");
const { updateProfile } = await import("../src/controllers/userController.js");
const { platformOverview } = await import("../src/controllers/admin.controller.js");
const Match = (await import("../src/models/match.model.js")).default;
const { applyMatchPayoutImpact } = await import("../src/controllers/dispute.controller.js");
const {
  getMyposMobileConfig,
  confirmMyposMobilePayment,
} = await import("../src/controllers/payments.controller.js");

async function ledgerBalance(accountType, accountId, currency = "GBP") {
  const rows = await LedgerEntry.aggregate([
    { $match: { accountType, accountId, currency, status: "POSTED" } },
    {
      $group: {
        _id: null,
        debit: { $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] } },
        credit: { $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] } },
      },
    },
  ]);
  const r = rows[0] || { debit: 0, credit: 0 };
  return r.credit - r.debit;
}

let failures = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(e?.stack || e);
  }
}

// ---- mock req/res ----
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
function playerReq(user, extra = {}) {
  return {
    userId: String(user._id),
    user,
    authType: "user",
    auth: { canPlay: true, actorType: "user" },
    params: {},
    query: {},
    body: {},
    ...extra,
  };
}

let _userSeq = 0;
async function mkUser(fields = {}) {
  // Always assign a unique username so usernameLower is non-null; the User model
  // has a unique index on usernameLower and multiple null values collide once
  // the index is built (otherwise the suite is order/timing dependent).
  _userSeq += 1;
  return User.create({
    username: fields.username || `tester_${_userSeq}`,
    profile: { nickname: fields.name || "P", role: "USER" },
    stats: {
      score: fields.score || 0,
      totalWinnings: fields.winnings || 0,
    },
    earnings: {
      career: fields.career || 0,
      total: fields.total || 0,
      availableBalance: fields.balance || 0,
    },
  });
}

// =====================================================================
// Phase A — money ranking via the real leaderboard controller
// =====================================================================
await t("A: leaderboard sortBy=money ranks by money, default by score", async () => {
  // The leaderboard displays the public username (falling back to nickname), so
  // give these rows explicit usernames matching the labels we assert on.
  const viewer = await mkUser({ name: "Viewer", username: "Viewer", score: 1, winnings: 1 });
  await mkUser({ name: "HighScore", username: "HighScore", score: 1000, winnings: 10 });
  await mkUser({ name: "RichLowScore", username: "RichLowScore", score: 5, winnings: 9999, career: 9999 });

  const resMoney = mkRes();
  await leaderboard(playerReq(viewer, { query: { sortBy: "money" } }), resMoney);
  assert.equal(resMoney.statusCode, 200);
  assert.equal(resMoney.body.meta.sortBy, "money");
  assert.equal(resMoney.body.leaderboard[0].name, "RichLowScore");

  const resScore = mkRes();
  await leaderboard(playerReq(viewer, { query: {} }), resScore);
  assert.equal(resScore.body.meta.sortBy, "score");
  assert.equal(resScore.body.leaderboard[0].name, "HighScore");

  // viewer standing is reported even though viewer is near the bottom
  assert.ok(resScore.body.viewer);
  assert.equal(resScore.body.viewer.userId, String(viewer._id));
});

// =====================================================================
// Phase B1 — discovery
// =====================================================================
await t("B1: discover returns only OPEN, joinable tournaments with correct flags", async () => {
  const club = new mongoose.Types.ObjectId();
  const open = await Tournament.create({
    title: "Open Cup",
    clubId: club,
    accessMode: "OPEN",
    entriesStatus: "OPEN",
    status: "DRAFT",
    formatStatus: "DRAFT",
    maxPlayers: 2,
    economy: { enabled: true, currency: "GBP", entryFeeMinor: 500 },
  });
  await Tournament.create({
    title: "Invite Only",
    clubId: club,
    accessMode: "INVITE_ONLY",
    entriesStatus: "OPEN",
    status: "DRAFT",
  });
  await Tournament.create({
    title: "Already Started",
    clubId: club,
    accessMode: "OPEN",
    entriesStatus: "OPEN",
    status: "ACTIVE",
  });

  const viewer = await mkUser({ name: "Seeker" });
  const res = mkRes();
  await discoverTournaments(playerReq(viewer, { query: {} }), res);
  assert.equal(res.statusCode, 200);
  const titles = res.body.data.map((d) => d.title);
  assert.deepEqual(titles, ["Open Cup"]); // only the open, not-started one
  const row = res.body.data[0];
  assert.equal(row.joinable, true);
  assert.equal(row.entryFee.amountMinor, 500);
  assert.equal(String(open._id), row.id);
});

// =====================================================================
// Phase B1 — capacity enforcement (the $expr atomic guard)
// =====================================================================
await t("B1: join enforces capacity — 3rd join into a 2-seat tournament is rejected", async () => {
  const tourn = await Tournament.create({
    title: "Tiny",
    accessMode: "OPEN",
    entriesStatus: "OPEN",
    status: "DRAFT",
    formatStatus: "DRAFT",
    maxPlayers: 2,
  });
  const u1 = await mkUser({ name: "U1" });
  const u2 = await mkUser({ name: "U2" });
  const u3 = await mkUser({ name: "U3" });

  for (const u of [u1, u2]) {
    const res = mkRes();
    await joinTournamentOpen(playerReq(u, { params: { tournamentId: String(tourn._id) } }), res);
    assert.equal(res.statusCode, 200, `join failed for ${u.profile.nickname}`);
    assert.equal(res.body.joined, true);
  }

  const res3 = mkRes();
  await joinTournamentOpen(playerReq(u3, { params: { tournamentId: String(tourn._id) } }), res3);
  assert.equal(res3.statusCode, 409);
  assert.equal(res3.body.code, "TOURNAMENT_FULL");

  const fresh = await Tournament.findById(tourn._id).lean();
  assert.equal(fresh.entrants.length, 2);
});

await t("B1: duplicate join is idempotent (alreadyJoined), not a second entrant", async () => {
  const tourn = await Tournament.create({
    title: "Dup", accessMode: "OPEN", entriesStatus: "OPEN", status: "DRAFT", maxPlayers: 0,
  });
  const u = await mkUser({ name: "Dupe" });
  const r1 = mkRes();
  await joinTournamentOpen(playerReq(u, { params: { tournamentId: String(tourn._id) } }), r1);
  const r2 = mkRes();
  await joinTournamentOpen(playerReq(u, { params: { tournamentId: String(tourn._id) } }), r2);
  assert.equal(r2.body.alreadyJoined, true);
  const fresh = await Tournament.findById(tourn._id).lean();
  assert.equal(fresh.entrants.length, 1);
});

// =====================================================================
// Phase B1 — safe leave (unpaid allowed, paid blocked)
// =====================================================================
await t("B1: unpaid player can leave; paid player is blocked", async () => {
  const tourn = await Tournament.create({
    title: "Leavable", accessMode: "OPEN", entriesStatus: "OPEN", status: "DRAFT", maxPlayers: 0,
  });
  const unpaid = await mkUser({ name: "Unpaid" });
  const paid = await mkUser({ name: "Paid" });

  for (const u of [unpaid, paid]) {
    const r = mkRes();
    await joinTournamentOpen(playerReq(u, { params: { tournamentId: String(tourn._id) } }), r);
  }

  // unpaid leaves OK
  const rLeave = mkRes();
  await leaveTournamentOpen(playerReq(unpaid, { params: { tournamentId: String(tourn._id) } }), rLeave);
  assert.equal(rLeave.statusCode, 200);
  assert.equal(rLeave.body.left, true);

  // paid player has a PAID order -> blocked
  await TournamentEntryOrder.create({
    orderId: "ORD-PAID-1",
    tournamentId: tourn._id,
    userId: paid._id,
    status: "PAID",
    amountMinor: 500,
    prizePoolMinor: 250,
  });
  const rPaid = mkRes();
  await leaveTournamentOpen(playerReq(paid, { params: { tournamentId: String(tourn._id) } }), rPaid);
  assert.equal(rPaid.statusCode, 409);
  assert.equal(rPaid.body.code, "ENTRY_FEE_PAID");

  const fresh = await Tournament.findById(tourn._id).lean();
  const ids = fresh.entrants.map((e) => String(e.entrantId));
  assert.ok(!ids.includes(String(unpaid._id)));
  assert.ok(ids.includes(String(paid._id)));
});

// =====================================================================
// Phase B money — prize distribution: credits once, idempotent, ranking-visible
// =====================================================================
await t("B$: prize settlement credits champion once and is idempotent", async () => {
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "true";

  const champ = await mkUser({ name: "Champ", score: 50, winnings: 0, career: 0, total: 0 });
  const tourn = await Tournament.create({
    title: "Money Cup",
    accessMode: "OPEN",
    entriesStatus: "CLOSED",
    status: "COMPLETED",
    championName: `uid:${champ._id}`,
    entrants: [
      { entrantId: champ._id, participantKey: `uid:${champ._id}`, userId: String(champ._id) },
    ],
    economy: { enabled: true, currency: "GBP", entryFeeMinor: 1000, prizePoolBps: 5000 },
  });
  // Two PAID orders => prize pool = 250 + 250 = 500
  await TournamentEntryOrder.create({
    orderId: "ORD-A", tournamentId: tourn._id, userId: champ._id, status: "PAID",
    amountMinor: 1000, prizePoolMinor: 250,
  });
  await TournamentEntryOrder.create({
    orderId: "ORD-B", tournamentId: tourn._id, userId: new mongoose.Types.ObjectId(),
    status: "PAID", amountMinor: 1000, prizePoolMinor: 250,
  });

  const first = await settleTournamentPrizes(String(tourn._id));
  assert.equal(first.ok, true);
  assert.equal(first.totalMinor, 500);
  assert.equal(first.allCredited, true);

  // Pool is 500 MINOR (£5). earnings.* / the ranking trio are stored in MAJOR
  // units (pounds), exactly like 1v1 wins — so the champion gets £5, not 500.
  // (This asserts the units-bug fix: the old code wrote the minor amount here.)
  const afterFirst = await User.findById(champ._id).lean();
  assert.equal(afterFirst.stats.totalWinnings, 5);
  assert.equal(afterFirst.earnings.career, 5);
  assert.equal(afterFirst.earnings.total, 5);
  assert.equal(afterFirst.earnings.availableBalance, 5);

  // Second settlement must NOT double-credit.
  const second = await settleTournamentPrizes(String(tourn._id));
  assert.equal(second.alreadySettled, true);
  const afterSecond = await User.findById(champ._id).lean();
  assert.equal(afterSecond.stats.totalWinnings, 5, "double credit happened!");

  // And the credited winnings now surface in the money leaderboard.
  const res = mkRes();
  await leaderboard(playerReq(champ, { query: { sortBy: "money" } }), res);
  const top = res.body.leaderboard.find((r) => r.userId === String(champ._id));
  assert.equal(top.moneyEarned, 5);
});

await t("B$: settlement disabled flag => no payout", async () => {
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "false";
  const champ = await mkUser({ name: "NoPay" });
  const tourn = await Tournament.create({
    title: "Flag Off", status: "COMPLETED", championName: `uid:${champ._id}`,
    entrants: [{ entrantId: champ._id, participantKey: `uid:${champ._id}` }],
    economy: { enabled: true },
  });
  const r = await settleTournamentPrizes(String(tourn._id));
  assert.equal(r.ok, false);
  assert.equal(r.code, "PAYOUTS_DISABLED");
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "true";
});

// =====================================================================
// Phase C2 — prize-pool ledger drawdown on payout
// =====================================================================
await t("C2: settling prizes draws down the PRIZE_POOL ledger account", async () => {
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "true";
  process.env.FEATURE_PAYMENTS_V2 = "true";

  const champ = await mkUser({ name: "DrawChamp" });
  const tourn = await Tournament.create({
    title: "Drawdown Cup",
    status: "COMPLETED",
    championName: `uid:${champ._id}`,
    entrants: [{ entrantId: champ._id, participantKey: `uid:${champ._id}`, userId: String(champ._id) }],
    economy: { enabled: true, currency: "GBP" },
  });
  await TournamentEntryOrder.create({
    orderId: "ORD-DRAW-1", tournamentId: tourn._id, userId: champ._id, status: "PAID",
    amountMinor: 1000, prizePoolMinor: 500,
  });

  // Seed the prize-pool ledger account with the held money.
  const poolAccountId = `PRIZE_TOURN_${tourn._id}`;
  await LedgerEntry.create({
    entryId: "LE-SEED-POOL-1",
    direction: "CREDIT",
    accountType: "PRIZE_POOL",
    accountId: poolAccountId,
    amountMinor: 500,
    currency: "GBP",
    status: "POSTED",
    sourceType: "SETTLEMENT",
    sourceId: "SEED",
  });
  assert.equal(await ledgerBalance("PRIZE_POOL", poolAccountId), 500);

  const result = await settleTournamentPrizes(String(tourn._id));
  assert.equal(result.ok, true);
  assert.equal(result.drawdown?.drawn, true);
  // Pool fully drawn down to zero.
  assert.equal(await ledgerBalance("PRIZE_POOL", poolAccountId), 0);

  process.env.FEATURE_PAYMENTS_V2 = "false";
});

// =====================================================================
// U1 + U2 — ledger↔earnings unification (FEATURE_LEDGER_UNIFIED)
// =====================================================================
await t("U2: creditUserWallet posts a balanced USER_WALLET credit and is idempotent", async () => {
  const u = await mkUser({ name: "WalletCredit" });
  const uid = String(u._id);
  const contra = `SYS_${uid}`;

  const r1 = await creditUserWallet({
    userId: uid, amountMinor: 1500,
    contraAccountType: "SYSTEM_ADJUSTMENT", contraAccountId: contra,
    sourceType: "PAYOUT", baseEntryId: `TEST_${uid}`,
  });
  assert.equal(r1.posted, true);
  assert.equal(await getUserWalletBalanceMinor({ userId: uid }), 1500);
  assert.equal(await ledgerBalance("SYSTEM_ADJUSTMENT", contra), -1500);

  // Re-run with the same baseEntryId → no double credit.
  const r2 = await creditUserWallet({
    userId: uid, amountMinor: 1500,
    contraAccountType: "SYSTEM_ADJUSTMENT", contraAccountId: contra,
    sourceType: "PAYOUT", baseEntryId: `TEST_${uid}`,
  });
  assert.equal(r2.already, true);
  assert.equal(await getUserWalletBalanceMinor({ userId: uid }), 1500);
});

await t("U1: getSpendableBalanceMinor uses ledger when flag on, fallback when off", async () => {
  const u = await mkUser({ name: "Spendable" });
  const uid = String(u._id);
  await creditUserWallet({
    userId: uid, amountMinor: 800,
    contraAccountType: "SYSTEM_ADJUSTMENT", contraAccountId: `SYS_${uid}`,
    sourceType: "PAYOUT", baseEntryId: `SPEND_${uid}`,
  });

  process.env.FEATURE_LEDGER_UNIFIED = "false";
  const off = await getSpendableBalanceMinor({ userId: uid, fallbackMinor: 2000 });
  assert.equal(off, 2000, "flag off → max(ledger, fallback)");

  process.env.FEATURE_LEDGER_UNIFIED = "true";
  const on = await getSpendableBalanceMinor({ userId: uid, fallbackMinor: 2000 });
  assert.equal(on, 800, "flag on → ledger only");

  process.env.FEATURE_LEDGER_UNIFIED = "false";
});

await t("U2: with FEATURE_LEDGER_UNIFIED, tournament prize credits USER_WALLET ledger (idempotent)", async () => {
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "true";
  process.env.FEATURE_LEDGER_UNIFIED = "true";

  const champ = await mkUser({ name: "LedgerChamp" });
  const tourn = await Tournament.create({
    title: "Unified Cup", status: "COMPLETED", championName: `uid:${champ._id}`,
    entrants: [{ entrantId: champ._id, participantKey: `uid:${champ._id}`, userId: String(champ._id) }],
    economy: { enabled: true, currency: "GBP" },
  });
  await TournamentEntryOrder.create({
    orderId: "ORD-UNI-1", tournamentId: tourn._id, userId: champ._id, status: "PAID",
    amountMinor: 1000, prizePoolMinor: 600,
  });
  const poolAccountId = `PRIZE_TOURN_${tourn._id}`;
  await LedgerEntry.create({
    entryId: `LE-SEED-UNI-${tourn._id}`, direction: "CREDIT", accountType: "PRIZE_POOL",
    accountId: poolAccountId, amountMinor: 600, currency: "GBP", status: "POSTED",
    sourceType: "SETTLEMENT", sourceId: "SEED",
  });

  const r = await settleTournamentPrizes(String(tourn._id));
  assert.equal(r.ok, true);
  // Winner's USER_WALLET ledger credited with the full pool (minor units).
  assert.equal(await getUserWalletBalanceMinor({ userId: String(champ._id) }), 600);
  // PRIZE_POOL drawn down by the same amount (contra of the credit).
  assert.equal(await ledgerBalance("PRIZE_POOL", poolAccountId), 0);
  // earnings cache is MAJOR (£6), not minor.
  const after = await User.findById(champ._id).lean();
  assert.equal(after.earnings.availableBalance, 6);
  // Unified path supersedes the gateway-out drawdown.
  assert.equal(r.drawdown, null);
  assert.ok(Array.isArray(r.ledgerCredits) && r.ledgerCredits.length === 1);

  process.env.FEATURE_LEDGER_UNIFIED = "false";
  process.env.FEATURE_TOURNAMENT_PAYOUTS = "true";
});

await t("U2: MATCH dispute reversal moves USER_WALLET ledger only when FEATURE_LEDGER_UNIFIED is on", async () => {
  // entryFee is MAJOR (£10) → pot £20, 10% commission → £18 payout = 1800 minor.
  const mkFinishedMatch = async (winner, loser) =>
    Match.create({
      players: [winner._id, loser._id],
      status: "finished",
      winner: winner._id,
      entryFee: 10,
    });

  // ---- flag OFF: cache moves, ledger untouched ----
  {
    const winner = await mkUser({ name: "DspWinOff", balance: 20 });
    const loser = await mkUser({ name: "DspLoseOff", balance: 0 });
    const match = await mkFinishedMatch(winner, loser);
    // Seed the winner's ledger so we can prove it is NOT touched when the flag is off.
    await creditUserWallet({
      userId: String(winner._id), amountMinor: 2000,
      contraAccountType: "SYSTEM_ADJUSTMENT", contraAccountId: `SYS_${winner._id}`,
      sourceType: "PAYOUT", baseEntryId: `SEEDOFF_${winner._id}`,
    });

    process.env.FEATURE_LEDGER_UNIFIED = "false";
    const r = await applyMatchPayoutImpact({
      dispute: { caseId: "DSP-OFF-1", moduleRefId: String(match._id) },
      action: "REVERSE_WINNER_TO_LOSER",
      session: null,
    });
    assert.equal(r.payoutApplied === false ? false : true, true); // sanity: it ran

    // Ledger is unchanged (still the seeded 2000 / 0).
    assert.equal(await getUserWalletBalanceMinor({ userId: String(winner._id) }), 2000);
    assert.equal(await getUserWalletBalanceMinor({ userId: String(loser._id) }), 0);
    // Earnings cache moved by £18.
    const w = await User.findById(winner._id).lean();
    const l = await User.findById(loser._id).lean();
    assert.equal(w.earnings.availableBalance, 2); // 20 - 18
    assert.equal(l.earnings.availableBalance, 18);
  }

  // ---- flag ON: ledger AND cache move together ----
  {
    const winner = await mkUser({ name: "DspWinOn", balance: 20 });
    const loser = await mkUser({ name: "DspLoseOn", balance: 0 });
    const match = await mkFinishedMatch(winner, loser);
    // The winner's original payout lives in the ledger (as it would post-U2).
    await creditUserWallet({
      userId: String(winner._id), amountMinor: 2000,
      contraAccountType: "SYSTEM_ADJUSTMENT", contraAccountId: `SYS_${winner._id}`,
      sourceType: "PAYOUT", baseEntryId: `SEEDON_${winner._id}`,
    });

    process.env.FEATURE_LEDGER_UNIFIED = "true";
    await applyMatchPayoutImpact({
      dispute: { caseId: "DSP-ON-1", moduleRefId: String(match._id) },
      action: "REVERSE_WINNER_TO_LOSER",
      session: null,
    });

    // Ledger transfer: winner -1800, loser +1800.
    assert.equal(await getUserWalletBalanceMinor({ userId: String(winner._id) }), 200);
    assert.equal(await getUserWalletBalanceMinor({ userId: String(loser._id) }), 1800);
    // Cache stays consistent with the ledger.
    const w = await User.findById(winner._id).lean();
    const l = await User.findById(loser._id).lean();
    assert.equal(w.earnings.availableBalance, 2);
    assert.equal(l.earnings.availableBalance, 18);

    process.env.FEATURE_LEDGER_UNIFIED = "false";
  }
});

// =====================================================================
// Phase C2 — tournament entry refund: idempotent, removes entrant
// =====================================================================
await t("C2: organiser refund removes entrant once and is idempotent", async () => {
  process.env.FEATURE_TOURNAMENT_ECONOMY_V2 = "true";
  process.env.FEATURE_TOURNAMENT_REFUNDS = "true";

  const clubId = new mongoose.Types.ObjectId();
  const clubReq = (orderId) => ({
    clubId: String(clubId),
    club: { _id: clubId },
    authType: "club",
    auth: { tokenRole: "CLUB" },
    params: { entryOrderId: orderId },
    query: {},
    body: {},
  });

  const player = await mkUser({ name: "Refundee" });
  const tourn = await Tournament.create({
    title: "Refundable Cup",
    clubId,
    accessMode: "OPEN",
    entriesStatus: "OPEN",
    status: "DRAFT",
    entrants: [
      { entrantId: player._id, participantKey: `uid:${player._id}`, userId: String(player._id) },
    ],
    economy: { enabled: true, currency: "GBP", entryFeeMinor: 1000 },
  });
  const order = await TournamentEntryOrder.create({
    orderId: "ORD-REFUND-1",
    tournamentId: tourn._id,
    clubId,
    userId: player._id,
    intentId: "INT-1",
    status: "PAID",
    amountMinor: 1000,
    prizePoolMinor: 500,
    organizerShareMinor: 500,
    ledgerApplied: false, // skip ledger reversal in this DB-only check
    entrantAdded: true,
  });

  const r1 = mkRes();
  await refundTournamentEntry(clubReq(order.orderId), r1);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.refunded, true);

  const afterFirst = await Tournament.findById(tourn._id).lean();
  assert.equal(afterFirst.entrants.length, 0, "entrant should be removed on refund");
  const orderAfter = await TournamentEntryOrder.findById(order._id).lean();
  assert.equal(orderAfter.status, "REFUNDED");

  // Second refund is idempotent.
  const r2 = mkRes();
  await refundTournamentEntry(clubReq(order.orderId), r2);
  assert.equal(r2.body.alreadyRefunded, true);

  // A different club cannot refund this tournament's entries.
  const otherClubId = new mongoose.Types.ObjectId();
  const order2 = await TournamentEntryOrder.create({
    orderId: "ORD-REFUND-2", tournamentId: tourn._id, clubId, userId: player._id, intentId: "INT-2",
    status: "PAID", amountMinor: 1000, prizePoolMinor: 500, organizerShareMinor: 500, ledgerApplied: false,
  });
  const rForbidden = mkRes();
  await refundTournamentEntry(
    { clubId: String(otherClubId), club: { _id: otherClubId }, authType: "club", params: { entryOrderId: "ORD-REFUND-2" }, query: {}, body: {} },
    rForbidden
  );
  assert.equal(rForbidden.statusCode, 403);

  // Refund after start is blocked.
  await Tournament.updateOne({ _id: tourn._id }, { $set: { status: "ACTIVE" } });
  const r3 = mkRes();
  await refundTournamentEntry(clubReq("ORD-REFUND-2"), r3);
  assert.equal(r3.statusCode, 409);
  assert.equal(r3.body.code, "TOURNAMENT_STARTED");
});

// =====================================================================
// Provider refunds — real gateway refund returns money to the player
// =====================================================================
await t("C2: provider refund issues a real gateway refund only when FEATURE_PROVIDER_REFUNDS is on", async () => {
  process.env.FEATURE_TOURNAMENT_ECONOMY_V2 = "true";
  process.env.FEATURE_TOURNAMENT_REFUNDS = "true";
  process.env.PAYMENTS_PROVIDER = "MOCK";

  const clubId = new mongoose.Types.ObjectId();
  const clubReq = (orderId) => ({
    clubId: String(clubId),
    club: { _id: clubId },
    authType: "club",
    auth: { tokenRole: "CLUB" },
    params: { entryOrderId: orderId },
    query: {},
    body: {},
  });

  const player = await mkUser({ name: "GatewayRefundee" });
  const tourn = await Tournament.create({
    title: "Gateway Refund Cup",
    clubId,
    accessMode: "OPEN",
    entriesStatus: "OPEN",
    status: "DRAFT",
    entrants: [
      { entrantId: player._id, participantKey: `uid:${player._id}`, userId: String(player._id) },
    ],
    economy: { enabled: true, currency: "GBP", entryFeeMinor: 1000 },
  });
  const mkOrder = (orderId, intentId) =>
    TournamentEntryOrder.create({
      orderId,
      tournamentId: tourn._id,
      clubId,
      userId: player._id,
      intentId,
      status: "PAID",
      amountMinor: 1000,
      prizePoolMinor: 500,
      organizerShareMinor: 500,
      ledgerApplied: false, // isolate the gateway-refund behaviour from ledger reversal
      entrantAdded: true,
    });
  const mkIntent = (intentId) =>
    PaymentIntent.create({
      intentId,
      module: "TOURNAMENT",
      moduleRefId: intentId,
      userId: player._id,
      provider: "MOCK",
      currency: "GBP",
      amountMinor: 1000,
      status: "PAID",
      providerPaymentId: `MOCK_PAY_${intentId}`,
    });

  // ---- flag OFF: prior behaviour — no gateway refund attempted ----
  delete process.env.FEATURE_PROVIDER_REFUNDS;
  await mkIntent("GW-INT-OFF");
  await mkOrder("ORD-GW-OFF", "GW-INT-OFF");
  const rOff = mkRes();
  await refundTournamentEntry(clubReq("ORD-GW-OFF"), rOff);
  assert.equal(rOff.statusCode, 200);
  assert.equal(rOff.body.refunded, true);
  assert.equal(rOff.body.providerRefund.attempted, false, "no gateway refund when flag off");
  const intentOff = await PaymentIntent.findOne({ intentId: "GW-INT-OFF" }).lean();
  assert.equal(intentOff.metadata?.providerRefund, undefined, "intent not touched by gateway refund");

  // ---- flag ON: a real gateway refund is issued and recorded on the intent ----
  process.env.FEATURE_PROVIDER_REFUNDS = "true";
  await mkIntent("GW-INT-ON");
  await mkOrder("ORD-GW-ON", "GW-INT-ON");
  const rOn = mkRes();
  await refundTournamentEntry(clubReq("ORD-GW-ON"), rOn);
  assert.equal(rOn.statusCode, 200);
  assert.equal(rOn.body.refunded, true);
  assert.equal(rOn.body.providerRefund.attempted, true);
  assert.equal(rOn.body.providerRefund.status, "REFUNDED");
  assert.equal(rOn.body.providerRefund.providerRefundId, "REFUND_GW-INT-ON");
  const intentOn = await PaymentIntent.findOne({ intentId: "GW-INT-ON" }).lean();
  assert.equal(intentOn.metadata.providerRefund.providerRefundId, "REFUND_GW-INT-ON");
  assert.equal(intentOn.metadata.providerRefund.amountMinor, 1000);

  // Order is refunded and entrant removed exactly as before.
  const orderOn = await TournamentEntryOrder.findOne({ orderId: "ORD-GW-ON" }).lean();
  assert.equal(orderOn.status, "REFUNDED");

  process.env.FEATURE_PROVIDER_REFUNDS = "false";
});

// =====================================================================
// Organizer payouts — cash out ORGANIZER_BALANCE
// =====================================================================
await t("Organizer payout: cashes out ORGANIZER_BALANCE, blocks overdraw, lists history", async () => {
  process.env.FEATURE_PAYMENTS_V2 = "true";
  process.env.FEATURE_ORGANIZER_PAYOUTS = "true";

  const clubId = new mongoose.Types.ObjectId();
  const owner = await mkUser({ name: "ClubOwner" });
  const clubReq = (body) => ({
    clubId: String(clubId),
    club: { _id: clubId },
    ownerUserId: String(owner._id),
    authType: "club",
    headers: {},
    query: {},
    body: body || {},
  });

  // Seed organizer earnings: +£20 to ORGANIZER_BALANCE(clubId).
  await LedgerEntry.create({
    entryId: "LE-ORG-1",
    direction: "CREDIT",
    accountType: "ORGANIZER_BALANCE",
    accountId: String(clubId),
    amountMinor: 2000,
    currency: "GBP",
    status: "POSTED",
    sourceType: "SETTLEMENT",
    sourceId: "ORG-SEED-1",
  });

  // Overdrawing the balance is rejected.
  const rOver = mkRes();
  await requestOrganizerPayout(clubReq({ amountMinor: 5000 }), rOver);
  assert.equal(rOver.statusCode, 400);
  assert.equal(rOver.body.code, "INSUFFICIENT_ORGANIZER_BALANCE");

  // A valid £12 payout moves funds to a hold and returns the reduced balance.
  const rOk = mkRes();
  await requestOrganizerPayout(clubReq({ amountMinor: 1200 }), rOk);
  assert.equal(rOk.statusCode, 201);
  assert.equal(rOk.body.payout.status, "REQUESTED");
  assert.equal(rOk.body.payout.amountMinor, 1200);
  assert.equal(rOk.body.organizer.balanceMinor, 800, "balance reduced by payout");

  // ORGANIZER_BALANCE ledger nets to 800 (2000 credit − 1200 debit).
  assert.equal(await ledgerBalance("ORGANIZER_BALANCE", String(clubId)), 800);

  // The payout shows up in the organiser's history with the live balance.
  const rList = mkRes();
  await listOrganizerPayouts(clubReq(), rList);
  assert.equal(rList.statusCode, 200);
  assert.equal(rList.body.payouts.length, 1);
  assert.equal(rList.body.organizer.balanceMinor, 800);

  // With the flag off, requests are refused (zero behaviour change by default).
  process.env.FEATURE_ORGANIZER_PAYOUTS = "false";
  const rDisabled = mkRes();
  await requestOrganizerPayout(clubReq({ amountMinor: 100 }), rDisabled);
  assert.equal(rDisabled.statusCode, 503);
  assert.equal(rDisabled.body.code, "ORGANIZER_PAYOUTS_DISABLED");
});

// =====================================================================
// Admin payout settlement — completes withdrawals, reverts to the OWNER
// =====================================================================
await t("Admin settlement: completes a player withdrawal and reverts an organiser payout to its own balance", async () => {
  process.env.FEATURE_PAYMENTS_V2 = "true";
  process.env.FEATURE_ORGANIZER_PAYOUTS = "true";

  const adminReq = (params, body) => ({
    user: { role: "admin", profile: { role: "admin" } },
    params: params || {},
    body: body || {},
    query: {},
  });

  // ---- Player withdrawal -> admin complete (money leaves the platform) ----
  const player = await mkUser({ name: "Withdrawer" });
  await LedgerEntry.create({
    entryId: "LE-WD-1",
    direction: "CREDIT",
    accountType: "USER_WALLET",
    accountId: String(player._id),
    amountMinor: 5000,
    currency: "GBP",
    status: "POSTED",
    sourceType: "SETTLEMENT",
    sourceId: "WD-SEED-1",
  });

  const rReq = mkRes();
  await requestWalletWithdrawal(
    {
      user: { _id: player._id, id: String(player._id) },
      userId: String(player._id),
      headers: {},
      query: {},
      body: { amountMinor: 2000 },
    },
    rReq
  );
  assert.equal(rReq.statusCode, 201);
  const playerPayoutId = rReq.body.payout.payoutId;
  // Wallet debited to 3000; the 2000 sits in the withdrawal hold.
  assert.equal(await ledgerBalance("USER_WALLET", String(player._id)), 3000);

  const rComplete = mkRes();
  await adminCompletePayout(adminReq({ payoutId: playerPayoutId }), rComplete);
  assert.equal(rComplete.statusCode, 200);
  assert.equal(rComplete.body.payout.status, "PAID");
  // Hold drained; wallet stays at 3000 (the money left the platform, not refunded).
  assert.equal(await ledgerBalance("HOLD_BALANCE", `WD_${playerPayoutId}`), 0);
  assert.equal(await ledgerBalance("USER_WALLET", String(player._id)), 3000);

  // ---- Organiser payout -> admin fail reverts to ORGANIZER_BALANCE ----
  const clubId = new mongoose.Types.ObjectId();
  const owner = await mkUser({ name: "OrgOwner2" });
  const clubReq = (body) => ({
    clubId: String(clubId),
    club: { _id: clubId },
    ownerUserId: String(owner._id),
    headers: {},
    query: {},
    body: body || {},
  });
  await LedgerEntry.create({
    entryId: "LE-ORG-2",
    direction: "CREDIT",
    accountType: "ORGANIZER_BALANCE",
    accountId: String(clubId),
    amountMinor: 3000,
    currency: "GBP",
    status: "POSTED",
    sourceType: "SETTLEMENT",
    sourceId: "ORG-SEED-2",
  });

  const rOP = mkRes();
  await requestOrganizerPayout(clubReq({ amountMinor: 1000 }), rOP);
  assert.equal(rOP.statusCode, 201);
  const orgPayoutId = rOP.body.payout.payoutId;
  assert.equal(await ledgerBalance("ORGANIZER_BALANCE", String(clubId)), 2000);

  const rFail = mkRes();
  await adminFailPayout(adminReq({ payoutId: orgPayoutId }, { reason: "rejected" }), rFail);
  assert.equal(rFail.statusCode, 200);
  assert.equal(rFail.body.payout.status, "FAILED");
  // Hold released; funds return to the CLUB's balance (not the acting admin).
  assert.equal(await ledgerBalance("HOLD_BALANCE", `OP_${orgPayoutId}`), 0);
  assert.equal(await ledgerBalance("ORGANIZER_BALANCE", String(clubId)), 3000);

  // ---- Admin list surfaces both payouts with their type ----
  const rList = mkRes();
  await adminListPayouts(adminReq({}, {}), rList);
  assert.equal(rList.statusCode, 200);
  assert.ok(rList.body.payouts.length >= 2, "lists player + organiser payouts");
  const types = new Set(rList.body.payouts.map((p) => p.type));
  assert.ok(types.has("PLAYER") && types.has("ORGANIZER"));
});

// =====================================================================
// Phase D — player dashboard & admin platform overview
// =====================================================================
await t("D: player dashboard aggregates stats, wallet balance and counts", async () => {
  const player = await mkUser({ name: "Dash", score: 120, winnings: 300, career: 300, total: 300 });
  // Wallet ledger: +1000 then -250 => balance 750.
  await LedgerEntry.create({
    entryId: "LE-DASH-1", direction: "CREDIT", accountType: "USER_WALLET",
    accountId: String(player._id), amountMinor: 1000, currency: "GBP", status: "POSTED",
    sourceType: "SETTLEMENT", sourceId: "S1",
  });
  await LedgerEntry.create({
    entryId: "LE-DASH-2", direction: "DEBIT", accountType: "USER_WALLET",
    accountId: String(player._id), amountMinor: 250, currency: "GBP", status: "POSTED",
    sourceType: "HOLD", sourceId: "S2",
  });
  await TournamentEntryOrder.create({
    orderId: "ORD-DASH-1", tournamentId: new mongoose.Types.ObjectId(), userId: player._id,
    status: "PAID", amountMinor: 500, prizePoolMinor: 250,
  });

  const res = mkRes();
  await dashboard(playerReq(player), res);
  assert.equal(res.statusCode, 200);
  const d = res.body.dashboard;
  assert.equal(d.stats.score, 120);
  assert.equal(d.money.moneyEarned, 300);
  assert.equal(d.money.walletBalanceMinor, 750);
  assert.equal(d.counts.tournamentsEntered, 1);
});

await t("D: admin overview reports counts and ledger-derived finance", async () => {
  await Tournament.create({ title: "Ov1", status: "DRAFT" });
  await Tournament.create({ title: "Ov2", status: "COMPLETED" });
  await LedgerEntry.create({
    entryId: "LE-OV-PLAT", direction: "CREDIT", accountType: "PLATFORM_REVENUE",
    accountId: "PLATFORM_DEFAULT", amountMinor: 1234, currency: "GBP", status: "POSTED",
    sourceType: "SETTLEMENT", sourceId: "S3",
  });
  await LedgerEntry.create({
    entryId: "LE-OV-PRIZE", direction: "CREDIT", accountType: "PRIZE_POOL",
    accountId: "PRIZE_TOURN_Z", amountMinor: 800, currency: "GBP", status: "POSTED",
    sourceType: "SETTLEMENT", sourceId: "S4",
  });

  const res = mkRes();
  await platformOverview({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  const o = res.body.overview;
  assert.ok(o.counts.tournaments >= 2);
  assert.equal(o.finance.platformRevenueMinor, 1234);
  assert.equal(o.finance.prizePoolHeldMinor, 800);
  assert.ok(o.counts.tournamentsByStatus.DRAFT >= 1);
});

// =====================================================================
// SECURITY — PATCH /api/user/me must not allow mass-assignment
// =====================================================================
await t("SECURITY: updateProfile cannot mass-assign role/admin/earnings/stats", async () => {
  const u = await mkUser({ name: "Victim", score: 7, winnings: 3, career: 3 });
  const before = await User.findById(u._id).lean();

  const res = mkRes();
  await updateProfile(
    {
      userId: String(u._id),
      user: u,
      body: {
        name: "New Display Name",
        profile: {
          isPlatformAdmin: true,
          isAdmin: true,
          role: "admin",
          fairPlay: 99,
          organizer: { clubId: "hacked" },
        },
        earnings: { availableBalance: 999999, career: 999999, total: 999999 },
        stats: { score: 999999, totalWinnings: 999999 },
      },
    },
    res
  );
  assert.equal(res.statusCode, 200, "the legitimate part of the update still succeeds");

  const after = await User.findById(u._id).lean();
  // Legitimate editable field IS applied.
  assert.equal(after.profile.name, "New Display Name");
  // Privileged profile fields are NOT mass-assigned.
  assert.notEqual(after.profile.isPlatformAdmin, true, "isPlatformAdmin must not be settable");
  assert.notEqual(after.profile.isAdmin, true, "isAdmin must not be settable");
  assert.notEqual(String(after.profile.role || "").toLowerCase(), "admin", "role must not be settable");
  // Server-controlled money/stats are unchanged.
  assert.equal(
    Number(after.earnings?.availableBalance || 0),
    Number(before.earnings?.availableBalance || 0),
    "availableBalance must not be settable"
  );
  assert.equal(
    Number(after.stats?.score || 0),
    Number(before.stats?.score || 0),
    "stats.score must not be settable"
  );
  assert.equal(
    Number(after.stats?.totalWinnings || 0),
    Number(before.stats?.totalWinnings || 0),
    "stats.totalWinnings must not be settable"
  );
});

// =====================================================================
// myPOS Mobile SDK — mobile-config + mobile/confirm
// =====================================================================
await t("myPOS mobile-config: 503 unless payments enabled + provider MYPOS", async () => {
  const u = await mkUser({ name: "CfgUser" });

  // Payments off → 503.
  process.env.FEATURE_PAYMENTS_V2 = "false";
  const r1 = mkRes();
  await getMyposMobileConfig(playerReq(u), r1);
  assert.equal(r1.statusCode, 503);

  // Payments on but provider MOCK → 503 (never leaks config).
  process.env.FEATURE_PAYMENTS_V2 = "true";
  process.env.PAYMENTS_PROVIDER = "MOCK";
  const r2 = mkRes();
  await getMyposMobileConfig(playerReq(u), r2);
  assert.equal(r2.statusCode, 503);

  // Provider MYPOS + configured → returns the init config incl. currency.
  process.env.PAYMENTS_PROVIDER = "MYPOS";
  process.env.MYPOS_WALLET_NUMBER = "40110856610";
  process.env.MYPOS_SID = "1341961";
  process.env.MYPOS_KEY_INDEX = "1";
  process.env.MYPOS_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nAAA\\n-----END RSA PRIVATE KEY-----";
  process.env.MYPOS_PUBLIC_CERT = "-----BEGIN CERTIFICATE-----\\nBBB\\n-----END CERTIFICATE-----";
  process.env.MYPOS_MOBILE_CURRENCY = "GBP";
  const r3 = mkRes();
  await getMyposMobileConfig(playerReq(u), r3);
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.body.config.sid, "1341961");
  assert.equal(r3.body.config.currency, "GBP");
  assert.ok(r3.body.config.privateKey && r3.body.config.publicKey);

  process.env.PAYMENTS_PROVIDER = "MOCK";
  process.env.FEATURE_PAYMENTS_V2 = "false";
});

await t("myPOS mobile/confirm: verifies, settles wallet top-up, idempotent, replay-guarded", async () => {
  process.env.FEATURE_PAYMENTS_V2 = "true";
  process.env.PAYMENTS_PROVIDER = "MYPOS";
  process.env.MYPOS_MOBILE_CURRENCY = "GBP";

  const buyer = await mkUser({ name: "MobBuyer" });

  // A pending MYPOS wallet top-up intent (as createWalletTopupIntent would make).
  const mkTopupIntent = async (id, amountMinor) =>
    PaymentIntent.create({
      intentId: id, module: "WALLET_TOPUP", userId: buyer._id, provider: "MYPOS",
      currency: "GBP", amountMinor, status: "PENDING_PAYMENT",
      statusTimeline: [{ status: "PENDING_PAYMENT", at: new Date(), note: "seed", actor: "test" }],
      metadata: { walletTopup: true },
    });

  const intentId = "PAY-MOB-1";
  await mkTopupIntent(intentId, 700);

  // Confirm WITHOUT a transaction reference → 422, no settlement.
  const noRef = mkRes();
  await confirmMyposMobilePayment(
    playerReq(buyer, { body: { intentId, status: "SUCCESS" } }),
    noRef
  );
  assert.equal(noRef.statusCode, 422);
  assert.equal(noRef.body.reason, "MISSING_TRANSACTION_REFERENCE");
  assert.equal(await getUserWalletBalanceMinor({ userId: String(buyer._id) }), 0);

  // Confirm with a reference → settles, wallet credited 700.
  const ok = mkRes();
  await confirmMyposMobilePayment(
    playerReq(buyer, { body: { intentId, transactionReference: "TXN-ABC-1", status: "SUCCESS" } }),
    ok
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.settled, true);
  assert.equal(ok.body.intent.status, "PAID");
  assert.equal(await getUserWalletBalanceMinor({ userId: String(buyer._id) }), 700);

  // Idempotent: re-confirm same intent+ref → still 700, no double credit.
  const again = mkRes();
  await confirmMyposMobilePayment(
    playerReq(buyer, { body: { intentId, transactionReference: "TXN-ABC-1", status: "SUCCESS" } }),
    again
  );
  assert.equal(again.statusCode, 200);
  assert.equal(await getUserWalletBalanceMinor({ userId: String(buyer._id) }), 700);

  // Ownership: a different user cannot confirm this intent.
  const other = await mkUser({ name: "MobOther" });
  const forbidden = mkRes();
  await confirmMyposMobilePayment(
    playerReq(other, { body: { intentId, transactionReference: "TXN-ABC-1", status: "SUCCESS" } }),
    forbidden
  );
  assert.equal(forbidden.statusCode, 403);

  // Replay guard: a NEW intent cannot reuse TXN-ABC-1.
  const intentId2 = "PAY-MOB-2";
  await mkTopupIntent(intentId2, 300);
  const replay = mkRes();
  await confirmMyposMobilePayment(
    playerReq(buyer, { body: { intentId: intentId2, transactionReference: "TXN-ABC-1", status: "SUCCESS" } }),
    replay
  );
  assert.equal(replay.statusCode, 422);
  assert.equal(replay.body.reason, "TRANSACTION_REFERENCE_REUSED");
  assert.equal(await getUserWalletBalanceMinor({ userId: String(buyer._id) }), 700);

  process.env.PAYMENTS_PROVIDER = "MOCK";
  process.env.FEATURE_PAYMENTS_V2 = "false";
});

// ---- teardown ----
await mongoose.connection.dropDatabase().catch(() => {}); // only the test db
await mongoose.disconnect();
if (mongod) await mongod.stop();

if (failures > 0) {
  console.error(`\n${failures} integration test(s) failed.`);
  process.exit(1);
}
console.log("\nAll integration tests passed.");
