import PaymentIntent from "../models/paymentIntent.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import Tournament from "../models/tournament.model.js";
import TournamentEntryOrder from "../models/tournamentEntryOrder.model.js";
import User from "../models/user.model.js";
import { resolvePaymentProvider } from "../services/payments/paymentProvider.factory.js";
import { applyLedgerRulesForIntent } from "./payments.controller.js";
import { addEntrantAndReseed } from "../services/tournament.service.js";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function tournamentEconomyEnabled() {
  return boolFromEnv("FEATURE_TOURNAMENT_ECONOMY_V2", false);
}

function paymentsEnabled() {
  return boolFromEnv("FEATURE_PAYMENTS_V2", false);
}

function providerName() {
  return upper(process.env.PAYMENTS_PROVIDER, "MOCK");
}

function providerEnv() {
  return upper(process.env.PAYMENTS_ENVIRONMENT, "SANDBOX") === "PRODUCTION"
    ? "PRODUCTION"
    : "SANDBOX";
}

function requestUserId(req) {
  return req.user?.id || req.user?._id || req.userId || null;
}

function requestClubId(req) {
  return req.clubId || req.club?._id || null;
}

function toObjectIdString(v) {
  return cleanString(v?.toString?.() || v);
}

function normalizeBps(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10000, Math.floor(n)));
}

function normalizeMinor(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "TOURNAMENT_ECONOMY_DISABLED",
    message: "Tournament economy is currently disabled.",
  });
}

function paymentUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "PAYMENTS_DISABLED",
    message: "Payments are currently not enabled for this environment.",
  });
}

function organizerAccountIdForTournament(tournament) {
  return cleanString(tournament?.clubId?._id || tournament?.clubId || "ORGANIZER_DEFAULT");
}

function prizePoolAccountIdForTournament(tournamentId) {
  return `PRIZE_TOURN_${cleanString(tournamentId)}`;
}

function platformAccountId() {
  return "PLATFORM_DEFAULT";
}

function tournamentEconomyConfig(tournament) {
  const economy = tournament?.economy && typeof tournament.economy === "object" ? tournament.economy : {};
  const entryFeeMinor = Math.max(1, normalizeMinor(economy.entryFeeMinor, 100));
  const organizerShareBps = normalizeBps(economy.organizerShareBps, 5000);
  const prizePoolBps = normalizeBps(economy.prizePoolBps, 5000);
  const totalKnown = organizerShareBps + prizePoolBps;
  const platformFeeBps = normalizeBps(
    economy.platformFeeBps,
    totalKnown >= 10000 ? 0 : 10000 - totalKnown
  );

  return {
    enabled: !!economy.enabled,
    currency: upper(economy.currency || "GBP"),
    entryFeeMinor,
    organizerShareBps,
    prizePoolBps,
    platformFeeBps,
    autoAddEntrantOnPayment:
      economy.autoAddEntrantOnPayment === undefined ? true : !!economy.autoAddEntrantOnPayment,
    updatedAt: economy.updatedAt || null,
  };
}

function orderResponse(order) {
  return {
    orderId: cleanString(order?.orderId),
    tournamentId: toObjectIdString(order?.tournamentId),
    intentId: cleanString(order?.intentId),
    status: upper(order?.status || "PENDING_PAYMENT"),
    amountMinor: normalizeMinor(order?.amountMinor),
    currency: upper(order?.currency || "GBP"),
    organizerShareMinor: normalizeMinor(order?.organizerShareMinor),
    prizePoolMinor: normalizeMinor(order?.prizePoolMinor),
    platformMinor: normalizeMinor(order?.platformMinor),
    ledgerApplied: !!order?.ledgerApplied,
    entrantAdded: !!order?.entrantAdded,
    paidAt: order?.paidAt || null,
    settledAt: order?.settledAt || null,
    createdAt: order?.createdAt || null,
    updatedAt: order?.updatedAt || null,
  };
}

function intentResponse(intent) {
  return {
    intentId: cleanString(intent?.intentId),
    module: upper(intent?.module || "TOURNAMENT"),
    moduleRefId: cleanString(intent?.moduleRefId),
    status: upper(intent?.status || "CREATED"),
    amountMinor: normalizeMinor(intent?.amountMinor),
    currency: upper(intent?.currency || "GBP"),
    provider: upper(intent?.provider || providerName()),
    environment: upper(intent?.environment || providerEnv()),
    checkoutUrl: cleanString(intent?.checkoutUrl),
    clientToken: cleanString(intent?.clientToken),
    providerPaymentId: cleanString(intent?.providerPaymentId),
    providerReference: cleanString(intent?.providerReference),
    expiresAt: intent?.expiresAt || null,
    createdAt: intent?.createdAt || null,
    updatedAt: intent?.updatedAt || null,
  };
}

function ensureSameClub(req, tournament) {
  const reqClubId = toObjectIdString(requestClubId(req));
  const tClubId = toObjectIdString(tournament?.clubId?._id || tournament?.clubId);
  if (!reqClubId || !tClubId || reqClubId !== tClubId) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
}

function userParticipantKey(userId) {
  return `uid:${cleanString(userId)}`;
}

function userDisplayName(user) {
  const nickname = cleanString(user?.profile?.nickname);
  if (nickname) return nickname;
  const username = cleanString(user?.username);
  if (username) return username;
  return "Player";
}

async function maybeCreateCheckoutSession(intent, body = {}) {
  const autoCreateCheckout =
    body.autoCreateCheckout == null
      ? true
      : String(body.autoCreateCheckout).toLowerCase() !== "false";
  if (!autoCreateCheckout) return intent;

  const provider = resolvePaymentProvider(intent.provider || providerName());
  const session = await provider.createCheckoutSession({
    intent,
    successUrl: cleanString(body.successUrl),
    cancelUrl: cleanString(body.cancelUrl),
    failureUrl: cleanString(body.failureUrl),
  });

  if (cleanString(session.providerPaymentId)) intent.providerPaymentId = cleanString(session.providerPaymentId);
  if (cleanString(session.providerReference)) intent.providerReference = cleanString(session.providerReference);
  if (cleanString(session.checkoutUrl)) intent.checkoutUrl = cleanString(session.checkoutUrl);
  if (cleanString(session.clientToken)) intent.clientToken = cleanString(session.clientToken);
  if (session.expiresAt) intent.expiresAt = new Date(session.expiresAt);

  const nextStatus = upper(session.status || "PENDING_PAYMENT");
  intent.status = nextStatus;
  intent.statusTimeline = [
    ...(Array.isArray(intent.statusTimeline) ? intent.statusTimeline : []),
    {
      status: nextStatus,
      at: new Date(),
      note: "Checkout session ready",
      actor: "provider",
    },
  ];

  await intent.save();
  return intent;
}

async function ledgerBalanceMinor({ accountType, accountId, currency = "GBP" }) {
  const rows = await LedgerEntry.aggregate([
    {
      $match: {
        accountType: upper(accountType),
        accountId: cleanString(accountId),
        currency: upper(currency, "GBP"),
        status: "POSTED",
      },
    },
    {
      $group: {
        _id: null,
        debitMinor: {
          $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0] },
        },
        creditMinor: {
          $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0] },
        },
      },
    },
  ]);
  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

export async function updateTournamentEconomyConfig(req, res) {
  if (!tournamentEconomyEnabled()) return serviceUnavailable(res);
  try {
    const tournamentId = cleanString(req.params.tournamentId || req.params.id);
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ ok: false, message: "Tournament not found" });
    ensureSameClub(req, tournament);

    const existing = tournamentEconomyConfig(tournament);
    const enabled = req.body?.enabled === undefined ? existing.enabled : !!req.body?.enabled;
    const entryFeeMinor = Math.max(1, normalizeMinor(req.body?.entryFeeMinor, existing.entryFeeMinor));
    const organizerShareBps = normalizeBps(req.body?.organizerShareBps, existing.organizerShareBps);
    const prizePoolBps = normalizeBps(req.body?.prizePoolBps, existing.prizePoolBps);
    const platformFeeBps = normalizeBps(
      req.body?.platformFeeBps,
      Math.max(0, 10000 - organizerShareBps - prizePoolBps)
    );
    if (organizerShareBps + prizePoolBps + platformFeeBps > 10000) {
      return res.status(400).json({
        ok: false,
        message: "Share percentages exceed 100%. Please adjust bps values.",
      });
    }

    tournament.economy = {
      enabled,
      currency: upper(req.body?.currency || existing.currency || "GBP"),
      entryFeeMinor,
      organizerShareBps,
      prizePoolBps,
      platformFeeBps,
      autoAddEntrantOnPayment:
        req.body?.autoAddEntrantOnPayment === undefined
          ? existing.autoAddEntrantOnPayment
          : !!req.body?.autoAddEntrantOnPayment,
      updatedAt: new Date(),
    };
    await tournament.save();

    return res.json({
      ok: true,
      message: "Tournament economy configuration updated.",
      economy: tournamentEconomyConfig(tournament),
    });
  } catch (e) {
    return res.status(e?.statusCode || 500).json({ ok: false, message: e.message || "Failed to update economy config" });
  }
}

export async function getTournamentEconomySummary(req, res) {
  if (!tournamentEconomyEnabled()) return serviceUnavailable(res);
  try {
    const tournamentId = cleanString(req.params.tournamentId || req.params.id);
    const tournament = await Tournament.findById(tournamentId).lean();
    if (!tournament) return res.status(404).json({ ok: false, message: "Tournament not found" });
    ensureSameClub(req, tournament);

    const economy = tournamentEconomyConfig(tournament);
    const rows = await TournamentEntryOrder.find({ tournamentId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const totals = rows.reduce(
      (acc, row) => {
        const amountMinor = normalizeMinor(row.amountMinor);
        const organizerShareMinor = normalizeMinor(row.organizerShareMinor);
        const prizePoolMinor = normalizeMinor(row.prizePoolMinor);
        const platformMinor = normalizeMinor(row.platformMinor);

        acc.totalOrders += 1;
        if (upper(row.status) === "PAID") {
          acc.paidOrders += 1;
          acc.grossMinor += amountMinor;
          acc.organizerMinor += organizerShareMinor;
          acc.prizePoolMinor += prizePoolMinor;
          acc.platformMinor += platformMinor;
        } else if (upper(row.status) === "PENDING_PAYMENT") {
          acc.pendingOrders += 1;
        } else {
          acc.failedOrders += 1;
        }
        return acc;
      },
      {
        totalOrders: 0,
        paidOrders: 0,
        pendingOrders: 0,
        failedOrders: 0,
        grossMinor: 0,
        organizerMinor: 0,
        prizePoolMinor: 0,
        platformMinor: 0,
      }
    );

    const organizerAccountId = organizerAccountIdForTournament(tournament);
    const prizePoolAccountId = prizePoolAccountIdForTournament(tournament._id);
    const [organizerBalanceMinor, prizePoolBalanceMinor] = await Promise.all([
      ledgerBalanceMinor({
        accountType: "ORGANIZER_BALANCE",
        accountId: organizerAccountId,
        currency: economy.currency,
      }),
      ledgerBalanceMinor({
        accountType: "PRIZE_POOL",
        accountId: prizePoolAccountId,
        currency: economy.currency,
      }),
    ]);

    return res.json({
      ok: true,
      economy,
      summary: {
        ...totals,
        organizerBalanceMinor,
        prizePoolBalanceMinor,
      },
      recentOrders: rows.map(orderResponse),
    });
  } catch (e) {
    return res.status(e?.statusCode || 500).json({ ok: false, message: e.message || "Failed to load tournament summary" });
  }
}

export async function createTournamentEntryIntent(req, res) {
  if (!tournamentEconomyEnabled()) return serviceUnavailable(res);
  if (!paymentsEnabled()) return paymentUnavailable(res);

  try {
    const userId = toObjectIdString(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const tournamentId = cleanString(req.params.tournamentId || req.body?.tournamentId);
    const tournament = await Tournament.findById(tournamentId).lean();
    if (!tournament) return res.status(404).json({ ok: false, message: "Tournament not found" });

    const economy = tournamentEconomyConfig(tournament);
    if (!economy.enabled) {
      return res.status(409).json({
        ok: false,
        code: "TOURNAMENT_ECONOMY_NOT_ENABLED",
        message: "Tournament payments are not enabled by organizer yet.",
      });
    }

    if (upper(tournament.entriesStatus, "OPEN") !== "OPEN") {
      return res.status(409).json({ ok: false, message: "Entries are closed for this tournament." });
    }
    if (["ACTIVE", "LIVE", "COMPLETED"].includes(upper(tournament.status, "DRAFT"))) {
      return res.status(409).json({ ok: false, message: "Tournament is already running or completed." });
    }

    const alreadyEntrant = Array.isArray(tournament.entrants)
      ? tournament.entrants.some((e) => cleanString(e?.participantKey) === userParticipantKey(userId))
      : false;
    if (alreadyEntrant) {
      return res.status(409).json({
        ok: false,
        code: "ALREADY_ENTERED",
        message: "You are already entered in this tournament.",
      });
    }

    const paidOrder = await TournamentEntryOrder.findOne({
      tournamentId,
      userId,
      status: "PAID",
    }).lean();
    if (paidOrder) {
      return res.status(409).json({
        ok: false,
        code: "ENTRY_ALREADY_PAID",
        message: "Tournament entry is already paid for this user.",
      });
    }

    const amountMinor = Math.max(1, normalizeMinor(req.body?.amountMinor, economy.entryFeeMinor));
    const organizerShareMinor = Math.floor((amountMinor * normalizeBps(economy.organizerShareBps, 0)) / 10000);
    const prizePoolMinor = Math.floor((amountMinor * normalizeBps(economy.prizePoolBps, 0)) / 10000);
    const platformMinor = Math.max(0, amountMinor - organizerShareMinor - prizePoolMinor);

    const orderId = generatePublicId("TEO");
    const intentId = generatePublicId("PAY");
    const now = Date.now();
    const expiresInMinutes = Math.max(1, Math.min(240, Number(req.body?.expiresInMinutes || 30)));
    const metadata = {
      tournamentId: cleanString(tournament._id),
      tournamentTitle: cleanString(tournament.title),
      tournamentEntryOrderId: orderId,
      organizerAccountId: organizerAccountIdForTournament(tournament),
      prizePoolAccountId: prizePoolAccountIdForTournament(tournament._id),
      platformAccountId: platformAccountId(),
      source: "TOURNAMENT_ENTRY_V2",
    };

    const order = await TournamentEntryOrder.create({
      orderId,
      tournamentId,
      clubId: tournament.clubId || null,
      userId,
      intentId,
      status: "PENDING_PAYMENT",
      currency: economy.currency,
      amountMinor,
      organizerShareMinor,
      prizePoolMinor,
      platformMinor,
      metadata,
    });

    let intent = await PaymentIntent.create({
      intentId,
      module: "TOURNAMENT",
      moduleRefId: orderId,
      userId,
      clubId: tournament.clubId || null,
      provider: providerName(),
      environment: providerEnv(),
      currency: economy.currency,
      amountMinor,
      commissionMinor: platformMinor,
      organizerShareMinor,
      prizePoolMinor,
      status: "CREATED",
      checkoutUrl: "",
      clientToken: "",
      expiresAt: new Date(now + expiresInMinutes * 60 * 1000),
      statusTimeline: [
        {
          status: "CREATED",
          at: new Date(now),
          note: "Tournament entry payment intent created",
          actor: "api",
        },
      ],
      metadata,
    });

    try {
      intent = await maybeCreateCheckoutSession(intent, req.body || {});
    } catch (providerErr) {
      return res.status(503).json({
        ok: false,
        code: upper(providerErr?.code || "PAYMENT_PROVIDER_ERROR"),
        message: cleanString(providerErr?.message || "Could not create checkout session"),
        order: orderResponse(order),
        intent: intentResponse(intent),
      });
    }

    if (cleanString(intent.providerPaymentId)) {
      await TournamentEntryOrder.findOneAndUpdate(
        { orderId: order.orderId },
        { providerPaymentId: cleanString(intent.providerPaymentId) }
      );
    }

    const freshOrder = await TournamentEntryOrder.findOne({ orderId: order.orderId }).lean();
    return res.status(201).json({
      ok: true,
      message: "Tournament entry checkout created.",
      order: orderResponse(freshOrder),
      intent: intentResponse(intent),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to create tournament entry intent" });
  }
}

export async function syncTournamentEntryPayment(req, res) {
  if (!tournamentEconomyEnabled()) return serviceUnavailable(res);
  if (!paymentsEnabled()) return paymentUnavailable(res);

  try {
    const userId = toObjectIdString(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const orderId = upper(req.params.entryOrderId || req.params.orderId || req.body?.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "entryOrderId is required" });

    const order = await TournamentEntryOrder.findOne({ orderId, userId });
    if (!order) return res.status(404).json({ ok: false, message: "Tournament entry order not found" });

    const intent = await PaymentIntent.findOne({ intentId: order.intentId, userId });
    if (!intent) {
      return res.status(404).json({
        ok: false,
        message: "Payment intent for this tournament entry was not found.",
      });
    }

    if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now() && upper(intent.status) === "CREATED") {
      intent.status = "EXPIRED";
      intent.statusTimeline = [
        ...(Array.isArray(intent.statusTimeline) ? intent.statusTimeline : []),
        { status: "EXPIRED", at: new Date(), note: "Intent expired", actor: "system" },
      ];
      await intent.save();
    }

    if (upper(intent.status) !== "PAID") {
      const nextOrderStatus = ["FAILED", "CANCELLED", "EXPIRED", "REFUNDED"].includes(upper(intent.status))
        ? upper(intent.status)
        : "PENDING_PAYMENT";
      order.status = nextOrderStatus;
      await order.save();
      return res.json({
        ok: true,
        synced: false,
        message: "Payment is not completed yet.",
        order: orderResponse(order),
        intent: intentResponse(intent),
      });
    }

    let ledger = { applied: false, reused: false };
    if (!order.ledgerApplied) {
      const applied = await applyLedgerRulesForIntent(intent, {
        trigger: "tournament_entry_sync",
        actor: "api",
      });
      ledger = {
        applied: !!applied?.applied,
        reused: !!applied?.reused,
        sourceId: cleanString(applied?.sourceId),
        settlementId: cleanString(applied?.settlementId),
      };
    } else {
      ledger = { applied: true, reused: true };
    }

    order.status = "PAID";
    order.ledgerApplied = true;
    order.paidAt = order.paidAt || new Date();
    order.settledAt = new Date();

    const tournament = await Tournament.findById(order.tournamentId).lean();
    let entrantAdded = !!order.entrantAdded;
    let entrantNote = "";

    if (tournament) {
      const economy = tournamentEconomyConfig(tournament);
      const shouldAutoAdd = economy.autoAddEntrantOnPayment || !!req.body?.forceAddEntrant;
      if (shouldAutoAdd && !order.entrantAdded) {
        const user = await User.findById(userId).select("username profile.nickname").lean();
        const entrantPayload = {
          participantKey: userParticipantKey(userId),
          entrantId: userId,
          userId,
          username: cleanString(user?.username),
          name: userDisplayName(user),
          isLocal: false,
        };

        try {
          const added = await addEntrantAndReseed(toObjectIdString(order.tournamentId), entrantPayload);
          entrantAdded = added?.added === false ? true : !!added?.added;
          entrantNote = added?.added ? "Entrant added to tournament." : "Entrant already existed.";
        } catch (entrantErr) {
          entrantAdded = false;
          entrantNote = cleanString(entrantErr?.message || "Could not auto-add entrant");
        }
      }
    }

    order.entrantAdded = entrantAdded;
    const nextMeta = order.metadata && typeof order.metadata === "object" ? { ...order.metadata } : {};
    nextMeta.entrantNote = entrantNote;
    order.metadata = nextMeta;
    await order.save();

    return res.json({
      ok: true,
      synced: true,
      message: "Tournament entry payment synced.",
      order: orderResponse(order),
      intent: intentResponse(intent),
      ledger,
      entrant: {
        added: !!entrantAdded,
        note: entrantNote,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to sync tournament payment" });
  }
}

export async function myTournamentEntryOrders(req, res) {
  if (!tournamentEconomyEnabled()) return serviceUnavailable(res);
  try {
    const userId = toObjectIdString(requestUserId(req));
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const rows = await TournamentEntryOrder.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const tournamentIds = Array.from(new Set(rows.map((row) => toObjectIdString(row.tournamentId)).filter(Boolean)));
    const tournaments = await Tournament.find({ _id: { $in: tournamentIds } })
      .select("title status clubId")
      .lean();
    const tMap = new Map(tournaments.map((t) => [toObjectIdString(t._id), t]));

    return res.json({
      ok: true,
      orders: rows.map((row) => {
        const t = tMap.get(toObjectIdString(row.tournamentId));
        return {
          ...orderResponse(row),
          tournament: t
            ? {
                id: toObjectIdString(t._id),
                title: cleanString(t.title),
                status: upper(t.status || "DRAFT"),
                clubId: toObjectIdString(t.clubId),
              }
            : null,
        };
      }),
      meta: {
        count: rows.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load tournament entry orders" });
  }
}
