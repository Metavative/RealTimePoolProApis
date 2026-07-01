import crypto from "node:crypto";
import PaymentIntent from "../models/paymentIntent.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import Payout from "../models/payout.model.js";
import PaymentWebhookEvent from "../models/paymentWebhookEvent.model.js";
import WalletHold from "../models/walletHold.model.js";
import Settlement from "../models/settlement.model.js";
import { resolvePaymentProvider } from "../services/payments/paymentProvider.factory.js";
import {
  hasMyPosConfig,
  buildPurchaseForm,
  verifyNotification,
  notificationStatus,
  myposConfig,
} from "../services/payments/providers/mypos.provider.js";
import { hasPlatformAdminAccess, strictWalletEnabled } from "../utils/authz.js";

const OPEN_INTENT_STATUSES = ["CREATED", "PENDING_PAYMENT", "PROCESSING"];
const TERMINAL_INTENT_STATUSES = [
  "PAID",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

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

function paymentsEnabled() {
  return boolFromEnv("FEATURE_PAYMENTS_V2", false);
}

function providerName() {
  return upper(process.env.PAYMENTS_PROVIDER, "MOCK");
}

// Currency the myPOS mobile SDK charges in — must equal your myPOS store's
// currency. Defaults to GBP (the app's wallet currency).
function myposMobileCurrency() {
  return upper(process.env.MYPOS_MOBILE_CURRENCY || "GBP");
}

function providerEnv() {
  const env = upper(process.env.PAYMENTS_ENVIRONMENT, "SANDBOX");
  return env === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

function requestUserId(req) {
  return req.user?.id || req.user?._id || req.userId || null;
}

function requestClubId(req) {
  return req.clubId || req.club?._id || null;
}

// Privileged wallet operations (settlement-side refunds, withdrawal payout
// approval) must be performed by a platform admin, never self-service. Returns
// true if the request may proceed; otherwise writes a 403 and returns false.
// Honours AUTHZ_STRICT_WALLET so the legacy behaviour can be restored if a
// flow genuinely needs it during later phases.
function ensureWalletAdmin(req, res) {
  if (!strictWalletEnabled()) return true;
  if (hasPlatformAdminAccess(req.user)) return true;
  res.status(403).json({
    ok: false,
    code: "ADMIN_REQUIRED",
    message: "This wallet operation requires administrator privileges.",
  });
  return false;
}

function toMinorFromBody(rawAmount, rawAmountMinor) {
  const directMinor = Number(rawAmountMinor);
  if (Number.isFinite(directMinor) && directMinor >= 1) {
    return Math.floor(directMinor);
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.floor(Math.round(amount * 100));
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch (_) {
    return "{}";
  }
}

function stableSortValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortValue(item));
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) {
      out[key] = stableSortValue(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalPayloadString(payload) {
  return safeJsonStringify(stableSortValue(payload || {}));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hmacSha256Hex(secret, payloadString) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(String(payloadString || ""))
    .digest("hex");
}

function normalizeSignature(value) {
  const raw = cleanString(value).replace(/^sha256=/i, "");
  return raw.toLowerCase();
}

function timingSafeHexEqual(a, b) {
  const left = normalizeSignature(a);
  const right = normalizeSignature(b);
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch (_) {
    return false;
  }
}

function providerWebhookSecret(provider) {
  const p = upper(provider, "UNKNOWN");
  if (p === "MYPOS") {
    return cleanString(
      process.env.MYPOS_WEBHOOK_SECRET || process.env.PAYMENTS_WEBHOOK_SECRET
    );
  }
  return cleanString(process.env.PAYMENTS_WEBHOOK_SECRET);
}

function webhookEnvFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return defaultValue;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function paymentsEnvIsProduction() {
  const env = upper(process.env.PAYMENTS_ENVIRONMENT || process.env.NODE_ENV || "");
  return env === "PRODUCTION" || env === "PROD" || env === "LIVE";
}

// Phase C: the MOCK provider has no secret and otherwise bypasses signature
// verification. That is fine for sandbox/dev but a forgery hole in production
// (anyone could POST /webhooks/MOCK to inject a "PAID" event). Allow the bypass
// only outside production, or when explicitly opted in. Exported for testing.
export function mockWebhookBypassAllowed() {
  if (webhookEnvFlag("ALLOW_MOCK_WEBHOOKS", false)) return true;
  return !paymentsEnvIsProduction();
}

// Phase C: only accept webhooks from known providers. Prevents an attacker from
// selecting an arbitrary provider in the URL to influence secret selection or
// trip the MOCK bypass. Exported for testing.
export function isKnownWebhookProvider(provider) {
  const p = upper(provider, "UNKNOWN");
  const base = new Set(["MOCK", "MYPOS"]);
  for (const extra of cleanString(process.env.WEBHOOK_PROVIDERS).split(",")) {
    const e = upper(extra);
    if (e) base.add(e);
  }
  return base.has(p);
}

// Verify a webhook signature. Prefers the exact raw request bytes (so real
// providers' signatures verify against what they actually signed); falls back
// to the canonical JSON form for backward compatibility with existing signers.
// Exported for testing.
export function verifyWebhookSignature({ provider, payload, signature, rawBody }) {
  const p = upper(provider, "UNKNOWN");
  const secret = providerWebhookSecret(p);
  if (!secret) {
    const allowMock = p === "MOCK" && mockWebhookBypassAllowed();
    return {
      verified: allowMock,
      reason: allowMock
        ? "mock_provider_signature_bypass"
        : p === "MOCK"
        ? "mock_bypass_disabled_in_production"
        : "webhook_secret_not_configured",
    };
  }

  const raw = typeof rawBody === "string" ? rawBody : "";
  const canonical = canonicalPayloadString(payload || {});

  // Try raw bytes first (exact provider signature), then canonical fallback.
  let expected = hmacSha256Hex(secret, raw || canonical);
  let verified = timingSafeHexEqual(signature, expected);
  if (!verified && raw) {
    const expectedCanonical = hmacSha256Hex(secret, canonical);
    if (timingSafeHexEqual(signature, expectedCanonical)) {
      verified = true;
      expected = expectedCanonical;
    }
  }

  return { verified, expected, reason: "hmac_sha256" };
}

function buildWebhookDedupeKey({ provider, providerEventId, eventType, payload, signature }) {
  const p = upper(provider, "UNKNOWN");
  const pe = upper(providerEventId);
  if (pe) {
    return upper(`${p}__EVENT__${pe}`);
  }

  const seed = [
    p,
    upper(eventType, "UNKNOWN"),
    sha256Hex(canonicalPayloadString(payload || {})),
  ].join("__");

  return upper(`${p}__HASH__${sha256Hex(seed)}`);
}

function statusFromWebhook({ eventType, payload }) {
  const direct = upper(
    payload?.status || payload?.state || payload?.result || payload?.outcome
  );
  if (direct) {
    if (
      [
        "CREATED",
        "PENDING_PAYMENT",
        "PROCESSING",
        "PAID",
        "FAILED",
        "CANCELLED",
        "EXPIRED",
        "REFUNDED",
        "PARTIALLY_REFUNDED",
      ].includes(direct)
    ) {
      return direct;
    }
    if (["SUCCESS", "SUCCEEDED", "COMPLETED", "APPROVED", "PAID_OUT"].includes(direct)) {
      return "PAID";
    }
    if (["PENDING", "IN_PROGRESS", "OPEN"].includes(direct)) {
      return "PROCESSING";
    }
    if (["ERROR", "DECLINED", "DENIED", "FAIL"].includes(direct)) {
      return "FAILED";
    }
  }

  const type = upper(eventType, "UNKNOWN");
  if (type.includes("PAID") || type.includes("SUCCESS") || type.includes("CAPTURED")) {
    return "PAID";
  }
  if (type.includes("REFUND")) return "REFUNDED";
  if (type.includes("CANCEL")) return "CANCELLED";
  if (type.includes("FAIL") || type.includes("ERROR") || type.includes("DECLIN")) {
    return "FAILED";
  }
  if (type.includes("PROCESS") || type.includes("PENDING")) {
    return "PROCESSING";
  }
  return "PENDING_PAYMENT";
}

function extractWebhookIntentLookup(payload = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === "object"
    ? payload.metadata
    : {};

  const intentId = upper(
    payload?.intentId ||
      payload?.intent_id ||
      payload?.paymentIntentId ||
      metadata.intentId ||
      metadata.intent_id
  );

  const providerPaymentId = cleanString(
    payload?.providerPaymentId ||
      payload?.paymentId ||
      payload?.payment_id ||
      payload?.id ||
      payload?.data?.id
  );

  const providerReference = cleanString(
    payload?.providerReference ||
      payload?.reference ||
      payload?.paymentReference ||
      payload?.payment_reference ||
      payload?.transactionId ||
      payload?.transaction_id
  );

  return { intentId, providerPaymentId, providerReference };
}

async function findPaymentIntentForWebhook({ provider, lookup }) {
  if (lookup.intentId) {
    const byIntentId = await PaymentIntent.findOne({ intentId: lookup.intentId });
    if (byIntentId) return byIntentId;
  }

  if (lookup.providerPaymentId) {
    const byProviderPaymentId = await PaymentIntent.findOne({
      provider: upper(provider, "UNKNOWN"),
      providerPaymentId: lookup.providerPaymentId,
    });
    if (byProviderPaymentId) return byProviderPaymentId;
  }

  if (lookup.providerReference) {
    const byProviderReference = await PaymentIntent.findOne({
      provider: upper(provider, "UNKNOWN"),
      providerReference: lookup.providerReference,
    });
    if (byProviderReference) return byProviderReference;
  }

  return null;
}

function allowWebhookStatusTransition(currentStatus, nextStatus) {
  const current = upper(currentStatus, "CREATED");
  const next = upper(nextStatus, current);

  if (current === next) return true;
  if (!isTerminalStatus(current)) return true;

  // Allow paid intents to move to refunded states from provider callbacks.
  if (current === "PAID" && ["REFUNDED", "PARTIALLY_REFUNDED"].includes(next)) {
    return true;
  }
  return false;
}

function paymentModule(value) {
  const x = upper(value, "SHOP");
  if (
    [
      "SHOP",
      "MATCH",
      "TOURNAMENT",
      "WALLET_TOPUP",
      "WITHDRAWAL",
      "REFERRAL",
      "ADJUSTMENT",
    ].includes(x)
  ) {
    return x;
  }
  return "SHOP";
}

function payoutResponse(payout) {
  return {
    payoutId: payout.payoutId,
    amountMinor: Number(payout.amountMinor || 0),
    feeMinor: Number(payout.feeMinor || 0),
    netAmountMinor: Number(payout.netAmountMinor || 0),
    currency: upper(payout.currency || "GBP"),
    status: upper(payout.status || "REQUESTED"),
    provider: upper(payout.provider || providerName()),
    requestedAt: payout.requestedAt || null,
    processedAt: payout.processedAt || null,
    createdAt: payout.createdAt || null,
    updatedAt: payout.updatedAt || null,
  };
}

function availableActions(status) {
  const s = upper(status || "CREATED");
  const open = OPEN_INTENT_STATUSES.includes(s);
  return {
    canCreateCheckoutSession: open,
    canCancel: open,
    canConfirm: open,
    isTerminal: TERMINAL_INTENT_STATUSES.includes(s),
  };
}

function paymentIntentResponse(intent) {
  const status = upper(intent.status || "CREATED");
  return {
    intentId: intent.intentId,
    module: intent.module,
    moduleRefId: cleanString(intent.moduleRefId),
    amountMinor: Number(intent.amountMinor || 0),
    currency: upper(intent.currency || "GBP"),
    status,
    provider: upper(intent.provider || providerName()),
    environment: upper(intent.environment || providerEnv()),
    providerPaymentId: cleanString(intent.providerPaymentId),
    providerReference: cleanString(intent.providerReference),
    checkoutUrl: cleanString(intent.checkoutUrl),
    clientToken: cleanString(intent.clientToken),
    expiresAt: intent.expiresAt || null,
    createdAt: intent.createdAt || null,
    updatedAt: intent.updatedAt || null,
    actions: availableActions(status),
  };
}

function serviceUnavailable(res) {
  return res.status(503).json({
    ok: false,
    code: "PAYMENTS_DISABLED",
    message: "Payments are currently not enabled for this environment.",
  });
}

function normalizeProviderStatus(value, fallback = "PENDING_PAYMENT") {
  const s = upper(value, fallback);
  if (
    [
      "CREATED",
      "PENDING_PAYMENT",
      "PROCESSING",
      "PAID",
      "FAILED",
      "CANCELLED",
      "EXPIRED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
    ].includes(s)
  ) {
    return s;
  }
  return upper(fallback, "PENDING_PAYMENT");
}

function isOpenStatus(status) {
  return OPEN_INTENT_STATUSES.includes(upper(status, "CREATED"));
}

function isTerminalStatus(status) {
  return TERMINAL_INTENT_STATUSES.includes(upper(status, "CREATED"));
}

function intentExpired(intent) {
  if (!intent?.expiresAt) return false;
  const exp = new Date(intent.expiresAt).getTime();
  return Number.isFinite(exp) && exp > 0 && exp <= Date.now();
}

function appendTimeline(intent, status, note, actor = "api") {
  const nextStatus = normalizeProviderStatus(status, intent.status || "CREATED");
  intent.status = nextStatus;
  const timeline = Array.isArray(intent.statusTimeline) ? intent.statusTimeline : [];
  timeline.push({
    status: nextStatus,
    at: new Date(),
    note: cleanString(note),
    actor: cleanString(actor, "api"),
  });
  intent.statusTimeline = timeline;
}

async function maybeExpireIntent(intent, actor = "system") {
  if (!intent) return intent;
  if (!isOpenStatus(intent.status)) return intent;
  if (!intentExpired(intent)) return intent;
  appendTimeline(intent, "EXPIRED", "Intent expired before payment completion", actor);
  await intent.save();
  return intent;
}

async function findOwnedIntent(req, intentId) {
  const userId = requestUserId(req);
  if (!userId) return null;
  const normalizedId = upper(intentId);
  if (!normalizedId) return null;
  return PaymentIntent.findOne({ intentId: normalizedId, userId });
}

function toErrorResponse(err) {
  const code = upper(err?.code || "");
  if (code === "MYPOS_NOT_CONFIGURED") {
    return {
      httpStatus: 503,
      code,
      message:
        "Payment provider is not configured yet. Add credentials and try again.",
    };
  }
  if (code.includes("NOT_IMPLEMENTED")) {
    return {
      httpStatus: 501,
      code,
      message: "Payment provider action is not implemented yet.",
    };
  }
  return {
    httpStatus: 500,
    code: code || "PAYMENT_PROVIDER_ERROR",
    message: cleanString(err?.message || "Payment provider request failed"),
  };
}

async function createOrRefreshCheckoutSession(intent, payload = {}) {
  const provider = resolvePaymentProvider(intent.provider || providerName());
  const session = await provider.createCheckoutSession({
    intent,
    successUrl: cleanString(payload.successUrl),
    cancelUrl: cleanString(payload.cancelUrl),
    failureUrl: cleanString(payload.failureUrl),
  });

  if (cleanString(session.providerPaymentId)) {
    intent.providerPaymentId = cleanString(session.providerPaymentId);
  }
  if (cleanString(session.providerReference)) {
    intent.providerReference = cleanString(session.providerReference);
  }
  if (cleanString(session.checkoutUrl)) {
    intent.checkoutUrl = cleanString(session.checkoutUrl);
  }
  if (cleanString(session.clientToken)) {
    intent.clientToken = cleanString(session.clientToken);
  }
  if (session.expiresAt) {
    intent.expiresAt = new Date(session.expiresAt);
  }

  const nextStatus = normalizeProviderStatus(session.status, "PENDING_PAYMENT");
  if (intent.status !== nextStatus) {
    appendTimeline(intent, nextStatus, "Checkout session ready", "provider");
  } else {
    appendTimeline(intent, intent.status, "Checkout session refreshed", "provider");
  }

  await intent.save();
  return intent;
}

const SUPPORTED_ACCOUNT_TYPES = new Set([
  "USER_WALLET",
  "ORGANIZER_BALANCE",
  "PLATFORM_REVENUE",
  "PRIZE_POOL",
  "REFERRAL_COMMISSION",
  "HOLD_BALANCE",
  "SYSTEM_ADJUSTMENT",
]);

function normalizeAccountType(value, fallback = "") {
  const accountType = upper(value, fallback);
  if (!SUPPORTED_ACCOUNT_TYPES.has(accountType)) return "";
  return accountType;
}

function normalizeMinor(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function walletAccountId(userId) {
  return cleanString(userId);
}

function holdResponse(hold) {
  return {
    holdId: hold.holdId,
    amountMinor: Number(hold.amountMinor || 0),
    currency: upper(hold.currency || "GBP"),
    status: upper(hold.status || "HELD"),
    reason: cleanString(hold.reason),
    targetAccountType: cleanString(hold.targetAccountType),
    targetAccountId: cleanString(hold.targetAccountId),
    expiresAt: hold.expiresAt || null,
    capturedAt: hold.capturedAt || null,
    releasedAt: hold.releasedAt || null,
    createdAt: hold.createdAt || null,
    updatedAt: hold.updatedAt || null,
  };
}

function appendHoldTimeline(hold, status, note, actor = "api") {
  hold.status = upper(status, hold.status || "HELD");
  const timeline = Array.isArray(hold.statusTimeline) ? hold.statusTimeline : [];
  timeline.push({
    status: upper(status, hold.status || "HELD"),
    at: new Date(),
    note: cleanString(note),
    actor: cleanString(actor, "api"),
  });
  hold.statusTimeline = timeline;
}

async function getLedgerAccountBalanceMinor({
  accountType,
  accountId,
  currency = "GBP",
  status = "POSTED",
}) {
  const at = normalizeAccountType(accountType);
  const aid = cleanString(accountId);
  if (!at || !aid) return 0;

  const rows = await LedgerEntry.aggregate([
    {
      $match: {
        accountType: at,
        accountId: aid,
        currency: upper(currency, "GBP"),
        status: upper(status, "POSTED"),
      },
    },
    {
      $group: {
        _id: null,
        debitMinor: {
          $sum: {
            $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0],
          },
        },
        creditMinor: {
          $sum: {
            $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0],
          },
        },
      },
    },
  ]);

  const row = rows[0] || { debitMinor: 0, creditMinor: 0 };
  return Number(row.creditMinor || 0) - Number(row.debitMinor || 0);
}

async function postBalancedLedgerEntries({
  intentId = null,
  currency = "GBP",
  sourceType = "MANUAL",
  sourceId = "",
  lines = [],
  metadata = {},
}) {
  const normalizedCurrency = upper(currency, "GBP");
  const normalizedSourceType = upper(sourceType, "MANUAL");
  const normalizedSourceId = cleanString(sourceId);

  const prepared = [];
  let debitTotal = 0;
  let creditTotal = 0;

  for (const line of lines) {
    const direction = upper(line?.direction);
    const accountType = normalizeAccountType(line?.accountType);
    const accountId = cleanString(line?.accountId);
    const amountMinor = normalizeMinor(line?.amountMinor);
    if (!["DEBIT", "CREDIT"].includes(direction)) {
      throw new Error("Invalid ledger direction");
    }
    if (!accountType) {
      throw new Error("Invalid ledger account type");
    }
    if (!accountId) {
      throw new Error("Invalid ledger account id");
    }
    if (amountMinor <= 0) {
      throw new Error("Ledger amount must be greater than zero");
    }

    if (direction === "DEBIT") debitTotal += amountMinor;
    if (direction === "CREDIT") creditTotal += amountMinor;

    prepared.push({
      entryId: generatePublicId("LE"),
      intentId: intentId || null,
      direction,
      accountType,
      accountId,
      amountMinor,
      currency: normalizedCurrency,
      status: "POSTED",
      sourceType: normalizedSourceType,
      sourceId: normalizedSourceId,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    });
  }

  if (debitTotal <= 0 || creditTotal <= 0 || debitTotal !== creditTotal) {
    throw new Error("Ledger entries are not balanced");
  }

  await LedgerEntry.insertMany(prepared, { ordered: true });
  return { debitTotal, creditTotal };
}

async function findOwnedWalletHold(req, holdId) {
  const userId = requestUserId(req);
  if (!userId) return null;
  const normalizedHoldId = upper(holdId);
  if (!normalizedHoldId) return null;
  return WalletHold.findOne({ holdId: normalizedHoldId, userId });
}

async function findOwnedPayout(req, payoutId) {
  const userId = requestUserId(req);
  if (!userId) return null;
  const normalizedPayoutId = upper(payoutId);
  if (!normalizedPayoutId) return null;
  return Payout.findOne({ payoutId: normalizedPayoutId, userId });
}

function toMinor(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function intentMeta(intent) {
  return intent?.metadata && typeof intent.metadata === "object" ? intent.metadata : {};
}

function intentModule(intent) {
  return upper(intent?.module || "SHOP");
}

function intentSourceId(intent) {
  return upper(`SETTLE_${cleanString(intent?.intentId || generatePublicId("PAY"))}`);
}

function organizerAccountIdFromIntent(intent) {
  const meta = intentMeta(intent);
  const clubRef = intent?.clubId?.toString?.() || intent?.clubId;
  return cleanString(meta.organizerAccountId || clubRef || "ORGANIZER_DEFAULT");
}

function prizePoolAccountIdFromIntent(intent) {
  const meta = intentMeta(intent);
  return cleanString(
    meta.prizePoolAccountId || (intent?.moduleRefId ? `PRIZE_${intent.moduleRefId}` : "PRIZE_GLOBAL")
  );
}

function referralAccountIdFromIntent(intent) {
  const meta = intentMeta(intent);
  return cleanString(
    meta.referralAccountId || meta.referrerUserId || "REFERRAL_DEFAULT"
  );
}

function platformAccountIdFromIntent(intent) {
  const meta = intentMeta(intent);
  return cleanString(meta.platformAccountId || "PLATFORM_DEFAULT");
}

function settlementLinesFromLedgerLines(lines = []) {
  const map = new Map();
  for (const line of lines) {
    const accountType = normalizeAccountType(line?.accountType);
    const accountId = cleanString(line?.accountId);
    const direction = upper(line?.direction);
    const amountMinor = toMinor(line?.amountMinor);
    if (!accountType || !accountId || !["DEBIT", "CREDIT"].includes(direction) || amountMinor <= 0) {
      continue;
    }
    const key = `${accountType}::${accountId}`;
    const row = map.get(key) || {
      accountType,
      accountId,
      debitMinor: 0,
      creditMinor: 0,
      note: "",
    };
    if (direction === "DEBIT") row.debitMinor += amountMinor;
    if (direction === "CREDIT") row.creditMinor += amountMinor;
    map.set(key, row);
  }
  return Array.from(map.values());
}

function computeIntentLedgerLines(intent) {
  const module = intentModule(intent);
  const totalMinor = toMinor(intent?.amountMinor);
  const currency = upper(intent?.currency || "GBP");

  if (totalMinor <= 0) {
    throw new Error("Payment intent amount must be greater than zero for settlement");
  }

  if (module === "WALLET_TOPUP") {
    return {
      currency,
      totalMinor,
      lines: [
        {
          direction: "DEBIT",
          accountType: "SYSTEM_ADJUSTMENT",
          accountId: "EXTERNAL_GATEWAY_IN",
          amountMinor: totalMinor,
        },
        {
          direction: "CREDIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(intent.userId?.toString?.() || intent.userId),
          amountMinor: totalMinor,
        },
      ],
    };
  }

  if (module === "REFERRAL") {
    return {
      currency,
      totalMinor,
      lines: [
        {
          direction: "DEBIT",
          accountType: "SYSTEM_ADJUSTMENT",
          accountId: "EXTERNAL_GATEWAY_IN",
          amountMinor: totalMinor,
        },
        {
          direction: "CREDIT",
          accountType: "REFERRAL_COMMISSION",
          accountId: referralAccountIdFromIntent(intent),
          amountMinor: totalMinor,
        },
      ],
    };
  }

  let organizerShareMinor = toMinor(intent?.organizerShareMinor);
  let prizePoolMinor = toMinor(intent?.prizePoolMinor);
  const meta = intentMeta(intent);
  let referralMinor = toMinor(meta.referralCommissionMinor);

  organizerShareMinor = Math.min(organizerShareMinor, totalMinor);
  prizePoolMinor = Math.min(prizePoolMinor, totalMinor - organizerShareMinor);
  referralMinor = Math.min(referralMinor, totalMinor - organizerShareMinor - prizePoolMinor);

  const platformMinor = Math.max(
    0,
    totalMinor - organizerShareMinor - prizePoolMinor - referralMinor
  );

  const lines = [
    {
      direction: "DEBIT",
      accountType: "SYSTEM_ADJUSTMENT",
      accountId: "EXTERNAL_GATEWAY_IN",
      amountMinor: totalMinor,
    },
  ];

  if (organizerShareMinor > 0) {
    lines.push({
      direction: "CREDIT",
      accountType: "ORGANIZER_BALANCE",
      accountId: organizerAccountIdFromIntent(intent),
      amountMinor: organizerShareMinor,
    });
  }

  if (prizePoolMinor > 0) {
    lines.push({
      direction: "CREDIT",
      accountType: "PRIZE_POOL",
      accountId: prizePoolAccountIdFromIntent(intent),
      amountMinor: prizePoolMinor,
    });
  }

  if (referralMinor > 0) {
    lines.push({
      direction: "CREDIT",
      accountType: "REFERRAL_COMMISSION",
      accountId: referralAccountIdFromIntent(intent),
      amountMinor: referralMinor,
    });
  }

  if (platformMinor > 0) {
    lines.push({
      direction: "CREDIT",
      accountType: "PLATFORM_REVENUE",
      accountId: platformAccountIdFromIntent(intent),
      amountMinor: platformMinor,
    });
  }

  return { currency, totalMinor, lines };
}

async function findSettlementByIntent(intent) {
  if (!intent?._id) return null;
  return Settlement.findOne({ intentId: intent._id }).lean();
}

export async function applyLedgerRulesForIntent(intent, { trigger = "manual", actor = "api" } = {}) {
  if (!intent) {
    return { applied: false, reason: "intent_not_found" };
  }
  if (upper(intent.status) !== "PAID") {
    return { applied: false, reason: "intent_not_paid" };
  }

  const meta = intentMeta(intent);
  const ledgerMeta =
    meta.ledgerPosting && typeof meta.ledgerPosting === "object" ? meta.ledgerPosting : {};
  const sourceId = cleanString(ledgerMeta.sourceId || intentSourceId(intent));

  if (ledgerMeta.posted === true) {
    const settlement = await findSettlementByIntent(intent);
    return {
      applied: true,
      reused: true,
      sourceId,
      settlementId: settlement?.settlementId || cleanString(ledgerMeta.settlementId),
    };
  }

  const existingEntries = await LedgerEntry.find({
    sourceType: "SETTLEMENT",
    sourceId,
    status: "POSTED",
  })
    .select({ _id: 1 })
    .lean();

  if (existingEntries.length > 0) {
    const settlement = await findSettlementByIntent(intent);
    intent.metadata = {
      ...meta,
      ledgerPosting: {
        posted: true,
        postedAt: new Date().toISOString(),
        sourceId,
        trigger,
        settlementId: settlement?.settlementId || cleanString(ledgerMeta.settlementId),
      },
      walletTopupSettled: intentModule(intent) === "WALLET_TOPUP" ? true : !!meta.walletTopupSettled,
      walletTopupSettledAt:
        intentModule(intent) === "WALLET_TOPUP"
          ? new Date().toISOString()
          : cleanString(meta.walletTopupSettledAt),
    };
    await intent.save();
    return {
      applied: true,
      reused: true,
      sourceId,
      settlementId: settlement?.settlementId || cleanString(ledgerMeta.settlementId),
    };
  }

  const plan = computeIntentLedgerLines(intent);
  await postBalancedLedgerEntries({
    intentId: intent._id,
    currency: plan.currency,
    sourceType: "SETTLEMENT",
    sourceId,
    metadata: {
      operation: "INTENT_SETTLEMENT",
      module: intentModule(intent),
      trigger,
    },
    lines: plan.lines,
  });

  const settlementId = upper(`ST_${intent.intentId}`);
  const settlementLines = settlementLinesFromLedgerLines(plan.lines);
  await Settlement.findOneAndUpdate(
    { settlementId },
    {
      settlementId,
      module: intentModule(intent),
      moduleRefId: cleanString(intent.moduleRefId),
      intentId: intent._id,
      currency: plan.currency,
      totalMinor: plan.totalMinor,
      settledMinor: plan.totalMinor,
      outstandingMinor: 0,
      status: "SETTLED",
      settledAt: new Date(),
      lines: settlementLines,
      metadata: {
        trigger,
        sourceId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  intent.metadata = {
    ...meta,
    ledgerPosting: {
      posted: true,
      postedAt: new Date().toISOString(),
      sourceId,
      trigger,
      settlementId,
    },
    walletTopupSettled: intentModule(intent) === "WALLET_TOPUP" ? true : !!meta.walletTopupSettled,
    walletTopupSettledAt:
      intentModule(intent) === "WALLET_TOPUP"
        ? new Date().toISOString()
        : cleanString(meta.walletTopupSettledAt),
  };
  appendTimeline(intent, intent.status, "Ledger settlement posted", actor);
  await intent.save();

  return {
    applied: true,
    reused: false,
    sourceId,
    settlementId,
  };
}

// Phase C2: flip a set of balanced ledger lines to their reversal. Pure +
// exported for testing. A balanced set stays balanced after flipping.
export function reverseLedgerLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((l) => ({
    ...l,
    direction: upper(l?.direction) === "DEBIT" ? "CREDIT" : "DEBIT",
  }));
}

// Phase C2: reverse a previously-posted intent settlement (refund). Idempotent
// via the deterministic REFUND_<intentId> sourceId. No-op (reversed:false) if
// the original settlement was never posted (e.g. mock/neutral mode), so callers
// can always invoke it safely. Marks the intent REFUNDED on success.
export async function reverseIntentSettlement(intent, { trigger = "refund", actor = "api" } = {}) {
  if (!intent) return { reversed: false, reason: "intent_not_found" };

  const meta = intentMeta(intent);
  const originalSourceId = cleanString(
    meta.ledgerPosting?.sourceId || intentSourceId(intent)
  );
  const refundSourceId = upper(`REFUND_${cleanString(intent.intentId)}`);

  // Already reversed? Idempotent.
  const existingRefund = await LedgerEntry.find({
    sourceType: "REFUND",
    sourceId: refundSourceId,
    status: "POSTED",
  })
    .select({ _id: 1 })
    .lean();
  if (existingRefund.length > 0) {
    return { reversed: true, reused: true, sourceId: refundSourceId };
  }

  // Only reverse if the original settlement actually posted ledger entries.
  const originalEntries = await LedgerEntry.find({
    sourceType: "SETTLEMENT",
    sourceId: originalSourceId,
    status: "POSTED",
  })
    .select({ _id: 1 })
    .lean();
  if (meta.ledgerPosting?.posted !== true && originalEntries.length === 0) {
    return { reversed: false, reason: "not_settled" };
  }

  const plan = computeIntentLedgerLines(intent);
  await postBalancedLedgerEntries({
    intentId: intent._id,
    currency: plan.currency,
    sourceType: "REFUND",
    sourceId: refundSourceId,
    metadata: { operation: "INTENT_REFUND_REVERSAL", module: intentModule(intent), trigger },
    lines: reverseLedgerLines(plan.lines),
  });

  intent.status = "REFUNDED";
  intent.metadata = {
    ...meta,
    refund: {
      reversed: true,
      reversedAt: new Date().toISOString(),
      sourceId: refundSourceId,
      trigger,
    },
  };
  appendTimeline(intent, "REFUNDED", "Settlement reversed (refund)", actor);
  await intent.save();

  return { reversed: true, reused: false, sourceId: refundSourceId };
}

function providerRefundsEnabled() {
  return boolFromEnv("FEATURE_PROVIDER_REFUNDS", false);
}

/**
 * Issue a REAL refund of the original charge with the payment provider — the
 * external, money-moving step that actually returns funds to the player's card.
 * This is distinct from reverseIntentSettlement(), which only reverses the
 * INTERNAL ledger; that alone never moves real money back to the customer.
 *
 * Gated behind FEATURE_PROVIDER_REFUNDS (default OFF): when off this is a no-op
 * and the caller behaves exactly as before (internal-only reversal), so existing
 * flows are unchanged until a live provider is wired and the flag is flipped.
 *
 * Idempotent: keyed on REFUND_<intentId> and short-circuits if a providerRefundId
 * is already recorded on the intent, so a retry can never double-refund a card.
 * The refund info is stored under metadata.providerRefund (a separate key from
 * metadata.refund, which reverseIntentSettlement owns) so the two never clobber
 * each other. Throws on provider error so the caller can abort and release its
 * claim — leaving nothing partially refunded.
 */
export async function requestProviderRefund(
  intent,
  { amountMinor, currency, reason = "REFUND", trigger = "refund", actor = "api" } = {}
) {
  if (!intent) return { attempted: false, reason: "intent_not_found" };
  if (!providerRefundsEnabled()) {
    return { attempted: false, reason: "provider_refunds_disabled" };
  }

  const meta = intentMeta(intent);

  // Idempotency: never ask the provider to refund the same charge twice.
  const existing = meta.providerRefund;
  if (existing && cleanString(existing.providerRefundId)) {
    return {
      attempted: true,
      reused: true,
      providerRefundId: cleanString(existing.providerRefundId),
      status: upper(existing.status || "REFUNDED"),
    };
  }

  const idempotencyKey = upper(`REFUND_${cleanString(intent.intentId)}`);
  const amt = Math.max(
    0,
    Math.floor(Number(amountMinor) || Number(intent.amountMinor) || 0)
  );
  const cur = upper(currency || intent.currency || "GBP");

  const provider = resolvePaymentProvider(intent.provider || providerName());
  if (typeof provider.refundPayment !== "function") {
    const err = new Error("Payment provider does not support refunds yet.");
    err.code = "PROVIDER_REFUND_NOT_SUPPORTED";
    throw err;
  }

  const result = await provider.refundPayment({
    intent,
    amountMinor: amt,
    currency: cur,
    reason: upper(reason),
    idempotencyKey,
  });

  const providerRefundId = cleanString(result?.providerRefundId) || idempotencyKey;
  const providerReference = cleanString(result?.providerReference);
  const status = upper(result?.status || "REFUNDED");

  intent.metadata = {
    ...meta,
    providerRefund: {
      providerRefundId,
      providerReference,
      status,
      amountMinor: amt,
      currency: cur,
      reason: upper(reason),
      trigger,
      at: new Date().toISOString(),
    },
  };
  // Record on the timeline WITHOUT changing the intent's lifecycle status — the
  // ledger reversal (reverseIntentSettlement) is what flips it to REFUNDED.
  const timeline = Array.isArray(intent.statusTimeline) ? intent.statusTimeline : [];
  timeline.push({
    status: upper(intent.status || "PAID"),
    at: new Date(),
    note: `Provider refund ${status.toLowerCase()} (${providerRefundId})`,
    actor: cleanString(actor, "api"),
  });
  intent.statusTimeline = timeline;
  await intent.save();

  return {
    attempted: true,
    reused: false,
    providerRefundId,
    providerReference,
    status,
    amountMinor: amt,
    currency: cur,
  };
}

// Phase C2: draw down a tournament's prize-pool ledger account when a prize is
// paid out, so PRIZE_TOURN_<id> doesn't keep a phantom balance. The winner's
// spendable money is credited via the earnings fields (in tournamentPayout
// service, consistent with match payouts); here we only zero out the pool by
// moving the paid amount to the gateway-out clearing account. This keeps the
// ledger internally balanced without double-crediting the winner.
//
// Idempotent (deterministic TPAYOUT_<id> sourceId) and capped at the pool's
// actual balance so it can never drive the account negative. No-op when
// FEATURE_PAYMENTS_V2 is off (no ledger to draw down).
export async function drawDownTournamentPrizePool({
  tournamentId,
  amountMinor,
  currency = "GBP",
  trigger = "tournament_payout",
}) {
  if (!paymentsEnabled()) return { drawn: false, reason: "payments_disabled" };

  const amt = normalizeMinor(amountMinor);
  if (amt <= 0) return { drawn: false, reason: "zero_amount" };

  const poolAccountId = `PRIZE_TOURN_${cleanString(tournamentId)}`;
  const sourceId = upper(`TPAYOUT_${cleanString(tournamentId)}`);
  const cur = upper(currency, "GBP");

  // Idempotency: don't draw down twice for the same tournament.
  const existing = await LedgerEntry.find({
    sourceType: "PAYOUT",
    sourceId,
    status: "POSTED",
  })
    .select({ _id: 1 })
    .lean();
  if (existing.length > 0) {
    return { drawn: true, reused: true, sourceId };
  }

  // Cap at the pool's actual balance so we never overdraw it negative.
  const poolBalance = await getLedgerAccountBalanceMinor({
    accountType: "PRIZE_POOL",
    accountId: poolAccountId,
    currency: cur,
  });
  const drawAmt = Math.min(amt, Math.max(0, poolBalance));
  if (drawAmt <= 0) return { drawn: false, reason: "empty_pool", poolBalance };

  await postBalancedLedgerEntries({
    currency: cur,
    sourceType: "PAYOUT",
    sourceId,
    metadata: {
      operation: "TOURNAMENT_PRIZE_DRAWDOWN",
      tournamentId: cleanString(tournamentId),
      trigger,
    },
    lines: [
      {
        direction: "DEBIT",
        accountType: "PRIZE_POOL",
        accountId: poolAccountId,
        amountMinor: drawAmt,
      },
      {
        direction: "CREDIT",
        accountType: "SYSTEM_ADJUSTMENT",
        accountId: "EXTERNAL_GATEWAY_OUT",
        amountMinor: drawAmt,
      },
    ],
  });

  return { drawn: true, reused: false, sourceId, amountMinor: drawAmt };
}


export async function v2Status(req, res) {
  return res.json({
    ok: true,
    paymentsV2: {
      enabled: paymentsEnabled(),
      provider: providerName(),
      environment: providerEnv(),
      serverTimeMs: Date.now(),
    },
  });
}

export async function createPaymentIntent(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const module = paymentModule(body.module);
    const moduleRefId = cleanString(body.moduleRefId);
    const currency = upper(body.currency || "GBP");
    const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
    const expiresInMinutes = Math.max(1, Math.min(240, Number(body.expiresInMinutes || 30)));
    const autoCreateCheckout =
      body.autoCreateCheckout == null
        ? true
        : String(body.autoCreateCheckout).toLowerCase() !== "false";

    if (amountMinor <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be greater than zero",
      });
    }

    const idempotencyKey = cleanString(
      req.headers["x-idempotency-key"] || body.idempotencyKey
    );

    if (idempotencyKey) {
      const existing = await PaymentIntent.findOne({
        userId,
        idempotencyKey,
      }).lean();

      if (existing) {
        return res.json({
          ok: true,
          reused: true,
          intent: paymentIntentResponse(existing),
        });
      }
    }

    const intentId = generatePublicId("PAY");
    const now = Date.now();
    const created = await PaymentIntent.create({
      intentId,
      module,
      moduleRefId,
      userId,
      clubId: requestClubId(req),
      provider: providerName(),
      environment: providerEnv(),
      currency,
      amountMinor,
      commissionMinor: Math.max(0, Number(body.commissionMinor || 0)),
      organizerShareMinor: Math.max(0, Number(body.organizerShareMinor || 0)),
      prizePoolMinor: Math.max(0, Number(body.prizePoolMinor || 0)),
      status: "CREATED",
      checkoutUrl: "",
      clientToken: "",
      idempotencyKey,
      expiresAt: new Date(now + expiresInMinutes * 60 * 1000),
      statusTimeline: [
        {
          status: "CREATED",
          at: new Date(now),
          note: "Intent created",
          actor: "api",
        },
      ],
      metadata:
        body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    });

    let intent = created;
    if (autoCreateCheckout) {
      try {
        intent = await createOrRefreshCheckoutSession(created, body);
      } catch (providerErr) {
        const handled = toErrorResponse(providerErr);
        const metadata =
          created.metadata && typeof created.metadata === "object"
            ? { ...created.metadata }
            : {};
        metadata.lastSessionError = {
          code: handled.code,
          message: handled.message,
          at: new Date().toISOString(),
        };
        created.metadata = metadata;
        await created.save();

        return res.status(handled.httpStatus).json({
          ok: false,
          code: handled.code,
          message: handled.message,
          intent: paymentIntentResponse(created),
        });
      }
    }

    return res.status(201).json({
      ok: true,
      intent: paymentIntentResponse(intent),
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "Duplicate payment intent",
      });
    }
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create payment intent",
    });
  }
}

export async function myPaymentIntents(req, res) {
  try {
    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const intents = await PaymentIntent.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      intents: intents.map(paymentIntentResponse),
      meta: {
        count: intents.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load payment intents",
    });
  }
}

export async function getPaymentIntent(req, res) {
  try {
    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);

    return res.json({
      ok: true,
      intent: paymentIntentResponse(intent),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load payment intent",
    });
  }
}

export async function applyIntentLedgerRules(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);
    if (upper(intent.status) !== "PAID") {
      return res.status(409).json({
        ok: false,
        code: "INTENT_NOT_PAID",
        message: "Ledger can be posted only after payment is completed.",
        intent: paymentIntentResponse(intent),
      });
    }

    const result = await applyLedgerRulesForIntent(intent, {
      trigger: "manual_ledger_apply",
      actor: "api",
    });

    return res.json({
      ok: true,
      intent: paymentIntentResponse(intent),
      ledger: {
        applied: !!result?.applied,
        reused: !!result?.reused,
        reason: cleanString(result?.reason),
        sourceId: cleanString(result?.sourceId),
        settlementId: cleanString(result?.settlementId),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to apply ledger rules",
    });
  }
}

export async function getIntentLedgerDetails(req, res) {
  try {
    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    const meta = intentMeta(intent);
    const sourceId = cleanString(
      meta?.ledgerPosting?.sourceId || intentSourceId(intent)
    );

    const entries = await LedgerEntry.find({
      $or: [
        { intentId: intent._id },
        { sourceType: "SETTLEMENT", sourceId },
      ],
    })
      .sort({ createdAt: 1 })
      .lean();

    const settlement = await Settlement.findOne({ intentId: intent._id }).lean();

    return res.json({
      ok: true,
      intent: paymentIntentResponse(intent),
      ledger: {
        sourceId,
        posted: meta?.ledgerPosting?.posted === true,
        postedAt: meta?.ledgerPosting?.postedAt || null,
        settlementId: cleanString(meta?.ledgerPosting?.settlementId || settlement?.settlementId),
        entries,
        settlement,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load intent ledger details",
    });
  }
}

export async function createCheckoutSession(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);
    if (isTerminalStatus(intent.status)) {
      return res.status(409).json({
        ok: false,
        code: "INTENT_TERMINAL",
        message: "This payment intent is already completed and cannot open checkout.",
        intent: paymentIntentResponse(intent),
      });
    }

    try {
      const nextIntent = await createOrRefreshCheckoutSession(intent, req.body || {});
      return res.json({
        ok: true,
        intent: paymentIntentResponse(nextIntent),
      });
    } catch (providerErr) {
      const handled = toErrorResponse(providerErr);
      return res.status(handled.httpStatus).json({
        ok: false,
        code: handled.code,
        message: handled.message,
      });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create checkout session",
    });
  }
}

export async function refreshPaymentIntent(req, res) {
  try {
    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);
    if (isTerminalStatus(intent.status)) {
      return res.json({ ok: true, intent: paymentIntentResponse(intent) });
    }

    try {
      const provider = resolvePaymentProvider(intent.provider || providerName());
      const providerState = await provider.fetchPaymentStatus({ intent });
      const nextStatus = normalizeProviderStatus(providerState?.status, intent.status);
      if (nextStatus !== upper(intent.status)) {
        appendTimeline(intent, nextStatus, "Payment status refreshed from provider", "provider");
      } else {
        appendTimeline(intent, intent.status, "Payment status refresh check", "provider");
      }
      if (cleanString(providerState?.providerPaymentId)) {
        intent.providerPaymentId = cleanString(providerState.providerPaymentId);
      }
      if (cleanString(providerState?.providerReference)) {
        intent.providerReference = cleanString(providerState.providerReference);
      }
      await intent.save();

      let ledger = null;
      if (nextStatus === "PAID") {
        const ledgerResult = await applyLedgerRulesForIntent(intent, {
          trigger: "manual_confirm",
          actor: "api",
        });
        ledger = {
          applied: !!ledgerResult?.applied,
          reused: !!ledgerResult?.reused,
          sourceId: cleanString(ledgerResult?.sourceId),
          settlementId: cleanString(ledgerResult?.settlementId),
          reason: cleanString(ledgerResult?.reason),
        };
      }

      return res.json({
        ok: true,
        intent: paymentIntentResponse(intent),
        ...(ledger ? { ledger } : {}),
      });
    } catch (providerErr) {
      const handled = toErrorResponse(providerErr);
      return res.status(handled.httpStatus).json({
        ok: false,
        code: handled.code,
        message: handled.message,
      });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to refresh payment intent",
    });
  }
}

export async function cancelPaymentIntent(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);
    if (!isOpenStatus(intent.status)) {
      return res.status(409).json({
        ok: false,
        code: "INTENT_NOT_CANCELLABLE",
        message: "This payment intent can no longer be cancelled.",
        intent: paymentIntentResponse(intent),
      });
    }

    try {
      const provider = resolvePaymentProvider(intent.provider || providerName());
      const result = await provider.cancelPayment({ intent, payload: req.body || {} });

      if (cleanString(result?.providerPaymentId)) {
        intent.providerPaymentId = cleanString(result.providerPaymentId);
      }
      if (cleanString(result?.providerReference)) {
        intent.providerReference = cleanString(result.providerReference);
      }

      const nextStatus = normalizeProviderStatus(result?.status, "CANCELLED");
      appendTimeline(intent, nextStatus, "Payment was cancelled", "api");
      await intent.save();

      return res.json({
        ok: true,
        intent: paymentIntentResponse(intent),
      });
    } catch (providerErr) {
      const handled = toErrorResponse(providerErr);
      return res.status(handled.httpStatus).json({
        ok: false,
        code: handled.code,
        message: handled.message,
      });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to cancel payment intent",
    });
  }
}

export async function confirmPaymentIntent(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    await maybeExpireIntent(intent);
    if (!isOpenStatus(intent.status)) {
      return res.status(409).json({
        ok: false,
        code: "INTENT_NOT_CONFIRMABLE",
        message: "This payment intent can no longer be confirmed.",
        intent: paymentIntentResponse(intent),
      });
    }

    try {
      const provider = resolvePaymentProvider(intent.provider || providerName());
      if (upper(provider?.name) !== "MOCK") {
        return res.status(400).json({
          ok: false,
          code: "MANUAL_CONFIRM_NOT_ALLOWED",
          message:
            "Manual confirmation is only available in mock mode. Real providers must confirm via webhooks.",
        });
      }

      const result = await provider.confirmPayment({
        intent,
        payload: req.body || {},
      });

      if (cleanString(result?.providerPaymentId)) {
        intent.providerPaymentId = cleanString(result.providerPaymentId);
      }
      if (cleanString(result?.providerReference)) {
        intent.providerReference = cleanString(result.providerReference);
      }

      const nextStatus = normalizeProviderStatus(result?.status, "PAID");
      appendTimeline(
        intent,
        nextStatus,
        nextStatus === "PAID"
          ? "Payment completed"
          : "Payment confirmation updated by provider",
        "provider"
      );

      if (nextStatus === "PAID") {
        const metadata =
          intent.metadata && typeof intent.metadata === "object"
            ? { ...intent.metadata }
            : {};
        metadata.paidAt = new Date().toISOString();
        intent.metadata = metadata;
      }

      await intent.save();

      return res.json({
        ok: true,
        intent: paymentIntentResponse(intent),
      });
    } catch (providerErr) {
      const handled = toErrorResponse(providerErr);
      return res.status(handled.httpStatus).json({
        ok: false,
        code: handled.code,
        message: handled.message,
      });
    }
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to confirm payment intent",
    });
  }
}

export async function createWalletTopupIntent(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
    let currency = upper(body.currency || "GBP");
    // The myPOS mobile SDK charges the card in the store currency
    // (MYPOS_MOBILE_CURRENCY). Force the intent currency to match so the recorded
    // intent can never silently diverge from the amount actually charged. Keep
    // this equal to your myPOS store currency (both should be GBP).
    if (providerName() === "MYPOS") {
      currency = myposMobileCurrency();
    }
    const expiresInMinutes = Math.max(1, Math.min(240, Number(body.expiresInMinutes || 30)));
    const idempotencyKey = cleanString(
      req.headers["x-idempotency-key"] || body.idempotencyKey
    );

    if (amountMinor <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be greater than zero",
      });
    }

    if (idempotencyKey) {
      const existing = await PaymentIntent.findOne({
        userId,
        module: "WALLET_TOPUP",
        idempotencyKey,
      }).lean();
      if (existing) {
        return res.json({
          ok: true,
          reused: true,
          intent: paymentIntentResponse(existing),
        });
      }
    }

    const now = Date.now();
    const created = await PaymentIntent.create({
      intentId: generatePublicId("PAY"),
      module: "WALLET_TOPUP",
      moduleRefId: cleanString(body.moduleRefId || ""),
      userId,
      clubId: requestClubId(req),
      provider: providerName(),
      environment: providerEnv(),
      currency,
      amountMinor,
      status: "CREATED",
      checkoutUrl: "",
      clientToken: "",
      idempotencyKey,
      expiresAt: new Date(now + expiresInMinutes * 60 * 1000),
      statusTimeline: [
        {
          status: "CREATED",
          at: new Date(now),
          note: "Wallet top-up intent created",
          actor: "api",
        },
      ],
      metadata: {
        ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
        walletTopup: true,
      },
    });

    let intent = created;
    try {
      intent = await createOrRefreshCheckoutSession(created, body);
    } catch (providerErr) {
      const handled = toErrorResponse(providerErr);
      const metadata =
        created.metadata && typeof created.metadata === "object"
          ? { ...created.metadata }
          : {};
      metadata.lastSessionError = {
        code: handled.code,
        message: handled.message,
        at: new Date().toISOString(),
      };
      created.metadata = metadata;
      await created.save();

      return res.status(handled.httpStatus).json({
        ok: false,
        code: handled.code,
        message: handled.message,
        intent: paymentIntentResponse(created),
      });
    }

    return res.status(201).json({
      ok: true,
      intent: paymentIntentResponse(intent),
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "Duplicate top-up intent",
      });
    }
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create wallet top-up intent",
    });
  }
}

export async function settleWalletTopup(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const intent = await findOwnedIntent(req, req.params.intentId);
    if (!intent) {
      return res.status(404).json({ ok: false, message: "Payment intent not found" });
    }

    if (upper(intent.module) !== "WALLET_TOPUP") {
      return res.status(400).json({
        ok: false,
        message: "This payment intent is not a wallet top-up",
      });
    }

    await maybeExpireIntent(intent);
    if (upper(intent.status) !== "PAID") {
      return res.status(409).json({
        ok: false,
        code: "TOPUP_NOT_PAID",
        message: "Top-up can only be settled after payment is completed.",
        intent: paymentIntentResponse(intent),
      });
    }

    const ledgerResult = await applyLedgerRulesForIntent(intent, {
      trigger: "wallet_topup_settle",
      actor: "api",
    });
    const userId = requestUserId(req);

    const balanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency: intent.currency,
    });

    return res.json({
      ok: true,
      reused: !!ledgerResult?.reused,
      intent: paymentIntentResponse(intent),
      ledger: {
        applied: !!ledgerResult?.applied,
        reused: !!ledgerResult?.reused,
        sourceId: cleanString(ledgerResult?.sourceId),
        settlementId: cleanString(ledgerResult?.settlementId),
        reason: cleanString(ledgerResult?.reason),
      },
      wallet: {
        currency: upper(intent.currency || "GBP"),
        balanceMinor,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to settle wallet top-up",
    });
  }
}

export async function createWalletHold(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
    const currency = upper(body.currency || "GBP");
    const reason = cleanString(body.reason || "Wallet hold");
    const expiresInMinutes = Math.max(1, Math.min(1440, Number(body.expiresInMinutes || 120)));
    const idempotencyKey = cleanString(
      req.headers["x-idempotency-key"] || body.idempotencyKey
    );

    if (amountMinor <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be greater than zero",
      });
    }

    if (idempotencyKey) {
      const existing = await WalletHold.findOne({ userId, idempotencyKey }).lean();
      if (existing) {
        return res.json({
          ok: true,
          reused: true,
          hold: holdResponse(existing),
        });
      }
    }

    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency,
    });
    if (walletBalanceMinor < amountMinor) {
      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_WALLET_BALANCE",
        message: "You do not have enough wallet balance for this hold.",
        wallet: {
          currency,
          balanceMinor: walletBalanceMinor,
        },
      });
    }

    const hold = await WalletHold.create({
      holdId: generatePublicId("HOLD"),
      userId,
      currency,
      amountMinor,
      status: "HELD",
      reason,
      idempotencyKey,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      statusTimeline: [
        {
          status: "HELD",
          at: new Date(),
          note: "Funds moved to hold balance",
          actor: "api",
        },
      ],
      metadata: {
        ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      },
    });

    try {
      await postBalancedLedgerEntries({
        currency,
        sourceType: "HOLD",
        sourceId: hold.holdId,
        metadata: {
          operation: "WALLET_HOLD_CREATE",
          reason,
        },
        lines: [
          {
            direction: "DEBIT",
            accountType: "USER_WALLET",
            accountId: walletAccountId(userId),
            amountMinor,
          },
          {
            direction: "CREDIT",
            accountType: "HOLD_BALANCE",
            accountId: hold.holdId,
            amountMinor,
          },
        ],
      });
    } catch (ledgerErr) {
      await WalletHold.deleteOne({ _id: hold._id }).catch(() => {});
      throw ledgerErr;
    }

    const nextWalletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency,
    });

    // Phase C2: the balance check above and the debit are not a single atomic
    // op, so a concurrent hold could race us below zero. Detect that here
    // (act-then-verify) and compensate: reverse the debit and drop the hold so
    // the wallet can never be left negative.
    if (nextWalletBalanceMinor < 0) {
      await postBalancedLedgerEntries({
        currency,
        sourceType: "HOLD",
        sourceId: `${hold.holdId}_RACE_REVERSAL`,
        metadata: { operation: "WALLET_HOLD_RACE_REVERSAL", reason },
        lines: [
          {
            direction: "CREDIT",
            accountType: "USER_WALLET",
            accountId: walletAccountId(userId),
            amountMinor,
          },
          {
            direction: "DEBIT",
            accountType: "HOLD_BALANCE",
            accountId: hold.holdId,
            amountMinor,
          },
        ],
      }).catch(() => {});
      await WalletHold.deleteOne({ _id: hold._id }).catch(() => {});
      return res.status(409).json({
        ok: false,
        code: "INSUFFICIENT_WALLET_BALANCE_RACE",
        message:
          "Wallet balance was insufficient due to a concurrent operation. Please retry.",
        wallet: {
          currency,
          balanceMinor: nextWalletBalanceMinor + amountMinor,
        },
      });
    }

    return res.status(201).json({
      ok: true,
      hold: holdResponse(hold),
      wallet: {
        currency,
        balanceMinor: nextWalletBalanceMinor,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create wallet hold",
    });
  }
}

export async function myWalletHolds(req, res) {
  try {
    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const holds = await WalletHold.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      holds: holds.map(holdResponse),
      meta: {
        count: holds.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load wallet holds",
    });
  }
}

export async function captureWalletHold(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const hold = await findOwnedWalletHold(req, req.params.holdId);
    if (!hold) {
      return res.status(404).json({ ok: false, message: "Wallet hold not found" });
    }

    if (upper(hold.status) !== "HELD") {
      return res.status(409).json({
        ok: false,
        code: "HOLD_NOT_ACTIVE",
        message: "This hold is no longer active.",
        hold: holdResponse(hold),
      });
    }

    if (hold.expiresAt && new Date(hold.expiresAt).getTime() <= Date.now()) {
      appendHoldTimeline(hold, "EXPIRED", "Hold expired before capture", "system");
      await hold.save();
      return res.status(409).json({
        ok: false,
        code: "HOLD_EXPIRED",
        message: "This hold has expired.",
        hold: holdResponse(hold),
      });
    }

    const body = req.body || {};
    const targetAccountType = normalizeAccountType(
      body.targetAccountType || "PLATFORM_REVENUE"
    );
    const targetAccountId = cleanString(body.targetAccountId || "PLATFORM_DEFAULT");
    if (!targetAccountType || !targetAccountId) {
      return res.status(400).json({
        ok: false,
        message: "Valid target account type and id are required.",
      });
    }

    // Atomically claim the hold (HELD -> CAPTURED) so two concurrent capture
    // (or capture+release) calls cannot both post ledger entries and
    // double-spend the held funds. The compare-and-set on `status` is the
    // single point of serialization.
    const now = new Date();
    const claimed = await WalletHold.findOneAndUpdate(
      { _id: hold._id, status: "HELD" },
      {
        $set: {
          status: "CAPTURED",
          targetAccountType,
          targetAccountId,
          capturedAt: now,
        },
        $push: {
          statusTimeline: {
            status: "CAPTURED",
            at: now,
            note: "Hold captured to target account",
            actor: "api",
          },
        },
      },
      { new: true }
    );

    if (!claimed) {
      const fresh = await findOwnedWalletHold(req, req.params.holdId);
      return res.status(409).json({
        ok: false,
        code: "HOLD_NOT_ACTIVE",
        message: "This hold is no longer active.",
        hold: fresh ? holdResponse(fresh) : undefined,
      });
    }

    try {
      await postBalancedLedgerEntries({
        currency: claimed.currency,
        sourceType: "HOLD",
        sourceId: claimed.holdId,
        metadata: {
          operation: "WALLET_HOLD_CAPTURE",
        },
        lines: [
          {
            direction: "DEBIT",
            accountType: "HOLD_BALANCE",
            accountId: claimed.holdId,
            amountMinor: Number(claimed.amountMinor || 0),
          },
          {
            direction: "CREDIT",
            accountType: targetAccountType,
            accountId: targetAccountId,
            amountMinor: Number(claimed.amountMinor || 0),
          },
        ],
      });
    } catch (postErr) {
      // Compensating action: release the claim so the hold can be retried.
      await WalletHold.updateOne(
        { _id: claimed._id, status: "CAPTURED" },
        {
          $set: { status: "HELD", capturedAt: null },
          $push: {
            statusTimeline: {
              status: "HELD",
              at: new Date(),
              note: "Capture reverted after ledger failure",
              actor: "system",
            },
          },
        }
      );
      throw postErr;
    }

    return res.json({
      ok: true,
      hold: holdResponse(claimed),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to capture wallet hold",
    });
  }
}

export async function releaseWalletHold(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const hold = await findOwnedWalletHold(req, req.params.holdId);
    if (!hold) {
      return res.status(404).json({ ok: false, message: "Wallet hold not found" });
    }

    if (upper(hold.status) !== "HELD") {
      return res.status(409).json({
        ok: false,
        code: "HOLD_NOT_ACTIVE",
        message: "This hold is no longer active.",
        hold: holdResponse(hold),
      });
    }

    const userId = requestUserId(req);

    // Atomically claim the hold (HELD -> RELEASED) so it cannot be released
    // twice, or released and captured concurrently.
    const now = new Date();
    const claimed = await WalletHold.findOneAndUpdate(
      { _id: hold._id, status: "HELD" },
      {
        $set: { status: "RELEASED", releasedAt: now },
        $push: {
          statusTimeline: {
            status: "RELEASED",
            at: now,
            note: "Hold released back to wallet",
            actor: "api",
          },
        },
      },
      { new: true }
    );

    if (!claimed) {
      const fresh = await findOwnedWalletHold(req, req.params.holdId);
      return res.status(409).json({
        ok: false,
        code: "HOLD_NOT_ACTIVE",
        message: "This hold is no longer active.",
        hold: fresh ? holdResponse(fresh) : undefined,
      });
    }

    try {
      await postBalancedLedgerEntries({
        currency: claimed.currency,
        sourceType: "HOLD",
        sourceId: claimed.holdId,
        metadata: {
          operation: "WALLET_HOLD_RELEASE",
        },
        lines: [
          {
            direction: "DEBIT",
            accountType: "HOLD_BALANCE",
            accountId: claimed.holdId,
            amountMinor: Number(claimed.amountMinor || 0),
          },
          {
            direction: "CREDIT",
            accountType: "USER_WALLET",
            accountId: walletAccountId(userId),
            amountMinor: Number(claimed.amountMinor || 0),
          },
        ],
      });
    } catch (postErr) {
      await WalletHold.updateOne(
        { _id: claimed._id, status: "RELEASED" },
        {
          $set: { status: "HELD", releasedAt: null },
          $push: {
            statusTimeline: {
              status: "HELD",
              at: new Date(),
              note: "Release reverted after ledger failure",
              actor: "system",
            },
          },
        }
      );
      throw postErr;
    }

    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency: claimed.currency,
    });

    return res.json({
      ok: true,
      hold: holdResponse(claimed),
      wallet: {
        currency: upper(claimed.currency || "GBP"),
        balanceMinor: walletBalanceMinor,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to release wallet hold",
    });
  }
}

export async function createWalletRefund(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    // Refunds credit a user's wallet from a platform/system source. This is a
    // privileged settlement operation and must not be self-service.
    if (!ensureWalletAdmin(req, res)) return;

    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const body = req.body || {};
    const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
    const currency = upper(body.currency || "GBP");
    const sourceAccountType = normalizeAccountType(
      body.sourceAccountType || "PLATFORM_REVENUE"
    );
    const sourceAccountId = cleanString(body.sourceAccountId || "PLATFORM_DEFAULT");
    const reason = cleanString(body.reason || "Wallet refund");

    if (amountMinor <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be greater than zero",
      });
    }
    if (!sourceAccountType || !sourceAccountId) {
      return res.status(400).json({
        ok: false,
        message: "Valid source account type and id are required.",
      });
    }

    if (sourceAccountType === "SYSTEM_ADJUSTMENT") {
      // SYSTEM_ADJUSTMENT is the external-gateway bridge account; debiting it
      // mints wallet credit (e.g. a genuine card-network refund). This is no
      // longer skipped silently — it must be requested explicitly so it cannot
      // happen by accident or via a default/guessed source.
      if (req.body?.allowSystemAdjustment !== true) {
        return res.status(400).json({
          ok: false,
          code: "SYSTEM_ADJUSTMENT_NOT_ALLOWED",
          message:
            "Refunding from SYSTEM_ADJUSTMENT requires allowSystemAdjustment=true.",
        });
      }
    } else {
      const sourceBalanceMinor = await getLedgerAccountBalanceMinor({
        accountType: sourceAccountType,
        accountId: sourceAccountId,
        currency,
      });
      if (sourceBalanceMinor < amountMinor) {
        return res.status(400).json({
          ok: false,
          code: "INSUFFICIENT_SOURCE_BALANCE",
          message: "Refund source does not have enough balance.",
        });
      }
    }

    const refundId = generatePublicId("RF");
    await postBalancedLedgerEntries({
      currency,
      sourceType: "REFUND",
      sourceId: refundId,
      metadata: {
        operation: "WALLET_REFUND",
        reason,
      },
      lines: [
        {
          direction: "DEBIT",
          accountType: sourceAccountType,
          accountId: sourceAccountId,
          amountMinor,
        },
        {
          direction: "CREDIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(userId),
          amountMinor,
        },
      ],
    });

    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency,
    });

    return res.status(201).json({
      ok: true,
      refundId,
      wallet: {
        currency,
        balanceMinor: walletBalanceMinor,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create wallet refund",
    });
  }
}

async function createWithdrawalRequestRecord(req) {
  const userId = requestUserId(req);
  if (!userId) {
    const err = new Error("Unauthorized");
    err.code = "UNAUTHORIZED";
    throw err;
  }

  const body = req.body || {};
  const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
  const currency = upper(body.currency || "GBP");
  const feeMinor = Math.max(0, Math.floor(Number(body.feeMinor || 0)));
  const netAmountMinor = Math.max(0, amountMinor - feeMinor);
  const idempotencyKey = cleanString(
    req.headers["x-idempotency-key"] || body.idempotencyKey
  );

  if (amountMinor <= 0) {
    const err = new Error("Amount must be greater than zero");
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  if (feeMinor > amountMinor) {
    const err = new Error("Fee cannot exceed withdrawal amount");
    err.code = "INVALID_FEE";
    throw err;
  }

  if (idempotencyKey) {
    const existing = await Payout.findOne({ userId, idempotencyKey }).lean();
    if (existing) {
      return { payout: existing, reused: true };
    }
  }

  const walletBalanceMinor = await getLedgerAccountBalanceMinor({
    accountType: "USER_WALLET",
    accountId: walletAccountId(userId),
    currency,
  });
  if (walletBalanceMinor < amountMinor) {
    const err = new Error("You do not have enough wallet balance for this withdrawal.");
    err.code = "INSUFFICIENT_WALLET_BALANCE";
    err.balanceMinor = walletBalanceMinor;
    throw err;
  }

  const payoutId = generatePublicId("PO");
  const holdAccountId = `WD_${payoutId}`;
  const created = await Payout.create({
    payoutId,
    userId,
    clubId: requestClubId(req),
    provider: providerName(),
    currency,
    amountMinor,
    feeMinor,
    netAmountMinor,
    status: "REQUESTED",
    destinationType: upper(body.destinationType || "BANK"),
    destinationLast4: cleanString(body.destinationLast4),
    idempotencyKey,
    requestedAt: new Date(),
    statusTimeline: [
      {
        status: "REQUESTED",
        at: new Date(),
        note: "Withdrawal requested and funds moved to hold",
        actor: "api",
      },
    ],
    metadata: {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      holdAccountId,
      withdrawalReason: cleanString(body.reason || ""),
    },
  });

  try {
    await postBalancedLedgerEntries({
      currency,
      sourceType: "WITHDRAWAL",
      sourceId: created.payoutId,
      metadata: {
        operation: "WITHDRAWAL_REQUEST",
      },
      lines: [
        {
          direction: "DEBIT",
          accountType: "USER_WALLET",
          accountId: walletAccountId(userId),
          amountMinor,
        },
        {
          direction: "CREDIT",
          accountType: "HOLD_BALANCE",
          accountId: holdAccountId,
          amountMinor,
        },
      ],
    });
  } catch (ledgerErr) {
    created.status = "FAILED";
    created.statusTimeline = [
      ...(Array.isArray(created.statusTimeline) ? created.statusTimeline : []),
      {
        status: "FAILED",
        at: new Date(),
        note: "Withdrawal hold posting failed",
        actor: "system",
      },
    ];
    await created.save().catch(() => {});
    throw ledgerErr;
  }

  return { payout: created, reused: false };
}

export async function requestWalletWithdrawal(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const result = await createWithdrawalRequestRecord(req);
    const userId = requestUserId(req);
    const currency = upper(result.payout.currency || "GBP");
    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency,
    });

    return res.status(result.reused ? 200 : 201).json({
      ok: true,
      reused: result.reused,
      payout: payoutResponse(result.payout),
      wallet: {
        currency,
        balanceMinor: walletBalanceMinor,
      },
    });
  } catch (e) {
    if (e?.code === "UNAUTHORIZED") {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    if (e?.code === "INVALID_AMOUNT" || e?.code === "INVALID_FEE") {
      return res.status(400).json({ ok: false, message: e.message });
    }
    if (e?.code === "INSUFFICIENT_WALLET_BALANCE") {
      return res.status(400).json({
        ok: false,
        code: e.code,
        message: e.message,
        wallet: {
          balanceMinor: Number(e.balanceMinor || 0),
        },
      });
    }
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to request wallet withdrawal",
    });
  }
}

export async function completeWalletWithdrawal(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    // Marking a payout as PAID releases real money out of the platform. This
    // is an administrator/back-office action, never self-service.
    if (!ensureWalletAdmin(req, res)) return;

    const payout = await findOwnedPayout(req, req.params.payoutId);
    if (!payout) {
      return res.status(404).json({ ok: false, message: "Withdrawal not found" });
    }

    const status = upper(payout.status || "REQUESTED");
    if (status === "PAID") {
      return res.json({ ok: true, reused: true, payout: payoutResponse(payout) });
    }
    if (!["REQUESTED", "PENDING_REVIEW", "APPROVED", "PROCESSING"].includes(status)) {
      return res.status(409).json({
        ok: false,
        code: "WITHDRAWAL_NOT_SETTLABLE",
        message: "This withdrawal cannot be completed in its current status.",
        payout: payoutResponse(payout),
      });
    }

    if (upper(payout.provider || providerName()) !== "MOCK") {
      return res.status(400).json({
        ok: false,
        code: "MANUAL_SETTLEMENT_NOT_ALLOWED",
        message:
          "Manual settlement is only available in mock mode. Real providers settle via webhooks/back-office.",
      });
    }

    const metadata =
      payout.metadata && typeof payout.metadata === "object"
        ? { ...payout.metadata }
        : {};
    const holdAccountId = cleanString(metadata.holdAccountId || `WD_${payout.payoutId}`);
    const amountMinor = Number(payout.amountMinor || 0);
    const feeMinor = Math.max(0, Number(payout.feeMinor || 0));
    const netAmountMinor = Math.max(0, amountMinor - feeMinor);

    const holdBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: holdAccountId,
      currency: payout.currency,
    });
    if (holdBalanceMinor < amountMinor) {
      return res.status(409).json({
        ok: false,
        code: "WITHDRAWAL_HOLD_INSUFFICIENT",
        message: "Withdrawal hold balance is insufficient for settlement.",
      });
    }

    // Atomically claim the payout (settlable -> PROCESSING) so two concurrent
    // completions cannot both post the payout ledger and double-pay.
    const claimedPayout = await Payout.findOneAndUpdate(
      {
        _id: payout._id,
        status: { $in: ["REQUESTED", "PENDING_REVIEW", "APPROVED", "PROCESSING"] },
      },
      { $set: { status: "PROCESSING" } },
      { new: true }
    );
    if (!claimedPayout) {
      const fresh = await findOwnedPayout(req, req.params.payoutId);
      return res.status(409).json({
        ok: false,
        code: "WITHDRAWAL_NOT_SETTLABLE",
        message: "This withdrawal is already being settled or is no longer settlable.",
        payout: fresh ? payoutResponse(fresh) : undefined,
      });
    }

    const lines = [
      {
        direction: "DEBIT",
        accountType: "HOLD_BALANCE",
        accountId: holdAccountId,
        amountMinor,
      },
      {
        direction: "CREDIT",
        accountType: "SYSTEM_ADJUSTMENT",
        accountId: "EXTERNAL_PAYOUT_OUT",
        amountMinor: netAmountMinor,
      },
    ];
    if (feeMinor > 0) {
      lines.push({
        direction: "CREDIT",
        accountType: "PLATFORM_REVENUE",
        accountId: "PLATFORM_DEFAULT",
        amountMinor: feeMinor,
      });
    }

    try {
      await postBalancedLedgerEntries({
        currency: claimedPayout.currency,
        sourceType: "WITHDRAWAL",
        sourceId: claimedPayout.payoutId,
        metadata: {
          operation: "WITHDRAWAL_COMPLETE",
        },
        lines,
      });
    } catch (postErr) {
      // Revert the claim to the original status so it can be retried.
      await Payout.updateOne(
        { _id: claimedPayout._id, status: "PROCESSING" },
        { $set: { status } }
      );
      throw postErr;
    }

    claimedPayout.status = "PAID";
    claimedPayout.processedAt = new Date();
    claimedPayout.providerReference = cleanString(
      req.body?.providerReference || `MOCK_PAYOUT_${Date.now()}`
    );
    claimedPayout.statusTimeline = [
      ...(Array.isArray(claimedPayout.statusTimeline) ? claimedPayout.statusTimeline : []),
      {
        status: "PAID",
        at: new Date(),
        note: "Withdrawal completed",
        actor: "api",
      },
    ];
    await claimedPayout.save();

    return res.json({
      ok: true,
      payout: payoutResponse(claimedPayout),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to complete wallet withdrawal",
    });
  }
}

export async function failWalletWithdrawal(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const payout = await findOwnedPayout(req, req.params.payoutId);
    if (!payout) {
      return res.status(404).json({ ok: false, message: "Withdrawal not found" });
    }

    const currentStatus = upper(payout.status || "REQUESTED");
    if (["FAILED", "CANCELLED", "REJECTED"].includes(currentStatus)) {
      return res.json({ ok: true, reused: true, payout: payoutResponse(payout) });
    }
    if (currentStatus === "PAID") {
      return res.status(409).json({
        ok: false,
        code: "WITHDRAWAL_ALREADY_PAID",
        message: "Completed withdrawals cannot be failed.",
      });
    }

    // Atomically claim the payout so the hold-to-wallet revert below cannot be
    // applied twice (which would double-credit the wallet).
    const claimedPayout = await Payout.findOneAndUpdate(
      {
        _id: payout._id,
        status: { $in: ["REQUESTED", "PENDING_REVIEW", "APPROVED", "PROCESSING"] },
      },
      { $set: { status: "PROCESSING" } },
      { new: true }
    );
    if (!claimedPayout) {
      const fresh = await findOwnedPayout(req, req.params.payoutId);
      const freshStatus = upper(fresh?.status || "");
      if (["FAILED", "CANCELLED", "REJECTED"].includes(freshStatus)) {
        return res.json({ ok: true, reused: true, payout: payoutResponse(fresh) });
      }
      return res.status(409).json({
        ok: false,
        code: "WITHDRAWAL_NOT_FAILABLE",
        message: "This withdrawal is already being settled or is no longer failable.",
        payout: fresh ? payoutResponse(fresh) : undefined,
      });
    }

    const metadata =
      claimedPayout.metadata && typeof claimedPayout.metadata === "object"
        ? { ...claimedPayout.metadata }
        : {};
    const holdAccountId = cleanString(metadata.holdAccountId || `WD_${claimedPayout.payoutId}`);
    const holdBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: holdAccountId,
      currency: claimedPayout.currency,
    });
    const releaseMinor = Math.max(
      0,
      Math.min(holdBalanceMinor, Number(claimedPayout.amountMinor || 0))
    );

    try {
      if (releaseMinor > 0) {
        await postBalancedLedgerEntries({
          currency: claimedPayout.currency,
          sourceType: "WITHDRAWAL",
          sourceId: claimedPayout.payoutId,
          metadata: {
            operation: "WITHDRAWAL_REVERT",
          },
          lines: [
            {
              direction: "DEBIT",
              accountType: "HOLD_BALANCE",
              accountId: holdAccountId,
              amountMinor: releaseMinor,
            },
            {
              direction: "CREDIT",
              accountType: "USER_WALLET",
              accountId: walletAccountId(requestUserId(req)),
              amountMinor: releaseMinor,
            },
          ],
        });
      }
    } catch (postErr) {
      await Payout.updateOne(
        { _id: claimedPayout._id, status: "PROCESSING" },
        { $set: { status: currentStatus } }
      );
      throw postErr;
    }

    const failedStatus = upper(req.body?.status || "FAILED");
    claimedPayout.status = ["FAILED", "CANCELLED", "REJECTED"].includes(failedStatus)
      ? failedStatus
      : "FAILED";
    claimedPayout.processedAt = new Date();
    claimedPayout.statusTimeline = [
      ...(Array.isArray(claimedPayout.statusTimeline) ? claimedPayout.statusTimeline : []),
      {
        status: claimedPayout.status,
        at: new Date(),
        note: cleanString(req.body?.reason || "Withdrawal reverted to wallet"),
        actor: "api",
      },
    ];
    await claimedPayout.save();

    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(requestUserId(req)),
      currency: claimedPayout.currency,
    });

    return res.json({
      ok: true,
      payout: payoutResponse(claimedPayout),
      wallet: {
        currency: upper(claimedPayout.currency || "GBP"),
        balanceMinor: walletBalanceMinor,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to fail wallet withdrawal",
    });
  }
}

export async function requestPayout(req, res) {
  try {
    if (!paymentsEnabled()) {
      return serviceUnavailable(res);
    }

    const result = await createWithdrawalRequestRecord(req);
    return res.status(result.reused ? 200 : 201).json({
      ok: true,
      reused: result.reused,
      payout: payoutResponse(result.payout),
    });
  } catch (e) {
    if (e?.code === "UNAUTHORIZED") {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    if (e?.code === "INVALID_AMOUNT" || e?.code === "INVALID_FEE") {
      return res.status(400).json({ ok: false, message: e.message });
    }
    if (e?.code === "INSUFFICIENT_WALLET_BALANCE") {
      return res.status(400).json({
        ok: false,
        code: e.code,
        message: e.message,
        wallet: {
          balanceMinor: Number(e.balanceMinor || 0),
        },
      });
    }
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to request payout",
    });
  }
}

export async function myPayouts(req, res) {
  try {
    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const payouts = await Payout.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      payouts: payouts.map(payoutResponse),
      meta: {
        count: payouts.length,
        limit,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load payouts",
    });
  }
}

export async function myLedgerEntries(req, res) {
  try {
    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const currency = upper(req.query.currency || "GBP");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const direction = upper(req.query.direction || "");
    const sourceType = upper(req.query.sourceType || "");
    const includeHolds = String(req.query.includeHolds || "").toLowerCase() === "true";

    const match = {
      currency,
      status: "POSTED",
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
    };
    if (["DEBIT", "CREDIT"].includes(direction)) {
      match.direction = direction;
    }
    if (sourceType) {
      match.sourceType = sourceType;
    }

    const walletEntries = await LedgerEntry.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    let holdEntries = [];
    if (includeHolds) {
      const holds = await WalletHold.find({ userId })
        .select({ holdId: 1 })
        .limit(300)
        .lean();
      const holdIds = holds.map((h) => upper(h.holdId)).filter(Boolean);
      if (holdIds.length > 0) {
        holdEntries = await LedgerEntry.find({
          currency,
          status: "POSTED",
          accountType: "HOLD_BALANCE",
          accountId: { $in: holdIds },
        })
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean();
      }
    }

    const entries = [...walletEntries, ...holdEntries]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    const walletBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "USER_WALLET",
      accountId: walletAccountId(userId),
      currency,
    });

    return res.json({
      ok: true,
      entries,
      wallet: {
        currency,
        balanceMinor: walletBalanceMinor,
      },
      meta: {
        count: entries.length,
        limit,
        includeHolds,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load ledger entries",
    });
  }
}

export async function myLedgerSummary(req, res) {
  try {
    const userId = requestUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const currency = upper(req.query.currency || "GBP");
    const accountId = String(userId);

    const summary = await LedgerEntry.aggregate([
      {
        $match: {
          accountType: "USER_WALLET",
          accountId,
          currency,
          status: "POSTED",
        },
      },
      {
        $group: {
          _id: null,
          debitMinor: {
            $sum: {
              $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amountMinor", 0],
            },
          },
          creditMinor: {
            $sum: {
              $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amountMinor", 0],
            },
          },
        },
      },
    ]);

    const row = summary[0] || { debitMinor: 0, creditMinor: 0 };
    const debitMinor = Number(row.debitMinor || 0);
    const creditMinor = Number(row.creditMinor || 0);
    const balanceMinor = creditMinor - debitMinor;

    return res.json({
      ok: true,
      wallet: {
        currency,
        debitMinor,
        creditMinor,
        balanceMinor,
      },
      meta: {
        accountId,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load ledger summary",
    });
  }
}

function organizerPayoutsEnabled() {
  return boolFromEnv("FEATURE_ORGANIZER_PAYOUTS", false);
}

// Organizer earnings accrue to ORGANIZER_BALANCE keyed by the club id (see
// organizerAccountIdFromIntent). A club-level balance, aggregated across all the
// club's tournaments.
function organizerAccountIdForClub(clubId) {
  return cleanString(clubId);
}

/**
 * POST /organizer/payouts  (club-authed)
 * Lets an organiser cash out their accrued ORGANIZER_BALANCE. Mirrors the player
 * withdrawal: moves funds ORGANIZER_BALANCE -> HOLD_BALANCE and creates a Payout
 * in REQUESTED status; the actual money-out settlement is an admin/back-office
 * step (never self-service). Gated behind FEATURE_ORGANIZER_PAYOUTS (default off)
 * and FEATURE_PAYMENTS_V2; idempotent via x-idempotency-key.
 */
export async function requestOrganizerPayout(req, res) {
  try {
    if (!paymentsEnabled()) return serviceUnavailable(res);
    if (!organizerPayoutsEnabled()) {
      return res.status(503).json({
        ok: false,
        code: "ORGANIZER_PAYOUTS_DISABLED",
        message: "Organizer payouts are not enabled for this environment.",
      });
    }

    const clubId = cleanString(req.clubId || req.club?._id);
    if (!clubId) {
      return res.status(401).json({ ok: false, message: "Club authorization required" });
    }

    // A Payout needs a userId to credit on settlement; use the club's linked
    // owner account. Without one we can't route the money, so block clearly.
    const ownerUserId = cleanString(req.ownerUserId);
    if (!ownerUserId) {
      return res.status(409).json({
        ok: false,
        code: "ORGANIZER_NO_OWNER_USER",
        message: "Link an owner account to this organizer before requesting a payout.",
      });
    }

    const body = req.body || {};
    const amountMinor = toMinorFromBody(body.amount, body.amountMinor);
    const currency = upper(body.currency || "GBP");
    if (amountMinor <= 0) {
      return res.status(400).json({ ok: false, message: "Amount must be greater than zero" });
    }

    const accountId = organizerAccountIdForClub(clubId);
    const balanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "ORGANIZER_BALANCE",
      accountId,
      currency,
    });
    if (balanceMinor < amountMinor) {
      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_ORGANIZER_BALANCE",
        message: "Your organizer balance is not enough for this payout.",
        organizer: { currency, balanceMinor },
      });
    }

    const idempotencyKey = cleanString(
      req.headers["x-idempotency-key"] || body.idempotencyKey
    );
    if (idempotencyKey) {
      const existing = await Payout.findOne({ clubId, idempotencyKey }).lean();
      if (existing) {
        return res.json({
          ok: true,
          reused: true,
          payout: payoutResponse(existing),
          organizer: { currency, balanceMinor },
        });
      }
    }

    const payoutId = generatePublicId("OPO");
    const holdAccountId = `OP_${payoutId}`;
    const created = await Payout.create({
      payoutId,
      userId: ownerUserId,
      clubId,
      provider: providerName(),
      currency,
      amountMinor,
      feeMinor: 0,
      netAmountMinor: amountMinor,
      status: "REQUESTED",
      destinationType: upper(body.destinationType || "BANK"),
      destinationLast4: cleanString(body.destinationLast4),
      idempotencyKey,
      requestedAt: new Date(),
      statusTimeline: [
        {
          status: "REQUESTED",
          at: new Date(),
          note: "Organizer payout requested and funds moved to hold",
          actor: "api",
        },
      ],
      metadata: {
        ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
        organizerPayout: true,
        organizerAccountId: accountId,
        holdAccountId,
      },
    });

    try {
      await postBalancedLedgerEntries({
        currency,
        sourceType: "WITHDRAWAL",
        sourceId: created.payoutId,
        metadata: { operation: "ORGANIZER_PAYOUT_REQUEST", clubId },
        lines: [
          {
            direction: "DEBIT",
            accountType: "ORGANIZER_BALANCE",
            accountId,
            amountMinor,
          },
          {
            direction: "CREDIT",
            accountType: "HOLD_BALANCE",
            accountId: holdAccountId,
            amountMinor,
          },
        ],
      });
    } catch (ledgerErr) {
      created.status = "FAILED";
      created.statusTimeline = [
        ...(Array.isArray(created.statusTimeline) ? created.statusTimeline : []),
        {
          status: "FAILED",
          at: new Date(),
          note: "Organizer payout hold posting failed",
          actor: "system",
        },
      ];
      await created.save().catch(() => {});
      throw ledgerErr;
    }

    const newBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "ORGANIZER_BALANCE",
      accountId,
      currency,
    });
    return res.status(201).json({
      ok: true,
      payout: payoutResponse(created),
      organizer: { currency, balanceMinor: newBalanceMinor },
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({ ok: false, message: "Duplicate payout request" });
    }
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to request organizer payout",
    });
  }
}

/**
 * GET /organizer/payouts  (club-authed)
 * The organiser's payout history plus their current ORGANIZER_BALANCE.
 */
export async function listOrganizerPayouts(req, res) {
  try {
    const clubId = cleanString(req.clubId || req.club?._id);
    if (!clubId) {
      return res.status(401).json({ ok: false, message: "Club authorization required" });
    }

    const currency = upper(req.query.currency || "GBP");
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const payouts = await Payout.find({ clubId, "metadata.organizerPayout": true })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const balanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "ORGANIZER_BALANCE",
      accountId: organizerAccountIdForClub(clubId),
      currency,
    });

    return res.json({
      ok: true,
      payouts: payouts.map(payoutResponse),
      organizer: { currency, balanceMinor },
      meta: { count: payouts.length, limit, serverTimeMs: Date.now() },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load organizer payouts",
    });
  }
}

// ---------------------------------------------------------------------------
// Admin / back-office payout settlement
//
// The player-facing completeWalletWithdrawal/failWalletWithdrawal use
// findOwnedPayout (caller-owned only), so they can't settle another user's
// payout and would mis-route a revert. These admin endpoints act on ANY payout
// and route the ledger to the correct owner: USER_WALLET for player
// withdrawals, ORGANIZER_BALANCE for organiser payouts. Admin-gated by route
// (adminMiddleware). Idempotency comes from the atomic Payout status claim.
// ---------------------------------------------------------------------------

const SETTLABLE_PAYOUT_STATUSES = [
  "REQUESTED",
  "PENDING_REVIEW",
  "APPROVED",
  "PROCESSING",
];

function payoutHoldAccountId(payout) {
  const meta =
    payout?.metadata && typeof payout.metadata === "object" ? payout.metadata : {};
  return cleanString(meta.holdAccountId || `WD_${payout.payoutId}`);
}

// Where a reverted (failed) payout's held funds should return: organiser payouts
// go back to ORGANIZER_BALANCE; everything else to the owner's USER_WALLET.
function payoutRevertCreditLine(payout, amountMinor) {
  const meta =
    payout?.metadata && typeof payout.metadata === "object" ? payout.metadata : {};
  if (meta.organizerPayout === true) {
    return {
      direction: "CREDIT",
      accountType: "ORGANIZER_BALANCE",
      accountId: cleanString(meta.organizerAccountId || payout.clubId),
      amountMinor,
    };
  }
  return {
    direction: "CREDIT",
    accountType: "USER_WALLET",
    accountId: walletAccountId(cleanString(payout.userId)),
    amountMinor,
  };
}

export async function adminListPayouts(req, res) {
  try {
    const status = upper(req.query.status || "");
    const type = upper(req.query.type || "");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    const query = {};
    if (status) query.status = status;
    if (type === "ORGANIZER") query["metadata.organizerPayout"] = true;
    if (type === "PLAYER") query["metadata.organizerPayout"] = { $ne: true };

    const rows = await Payout.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      payouts: rows.map((p) => ({
        ...payoutResponse(p),
        userId: cleanString(p.userId),
        clubId: cleanString(p.clubId),
        type: p?.metadata?.organizerPayout ? "ORGANIZER" : "PLAYER",
      })),
      meta: { count: rows.length, limit, serverTimeMs: Date.now() },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load payouts",
    });
  }
}

export async function adminCompletePayout(req, res) {
  try {
    if (!paymentsEnabled()) return serviceUnavailable(res);

    const payoutId = upper(req.params.payoutId);
    const payout = await Payout.findOne({ payoutId });
    if (!payout) return res.status(404).json({ ok: false, message: "Payout not found" });

    const status = upper(payout.status || "REQUESTED");
    if (status === "PAID") {
      return res.json({ ok: true, reused: true, payout: payoutResponse(payout) });
    }
    if (!SETTLABLE_PAYOUT_STATUSES.includes(status)) {
      return res.status(409).json({
        ok: false,
        code: "PAYOUT_NOT_SETTLABLE",
        message: "This payout cannot be completed in its current status.",
        payout: payoutResponse(payout),
      });
    }

    const holdAccountId = payoutHoldAccountId(payout);
    const amountMinor = Number(payout.amountMinor || 0);
    const feeMinor = Math.max(0, Number(payout.feeMinor || 0));
    const netAmountMinor = Math.max(0, amountMinor - feeMinor);

    const holdBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: holdAccountId,
      currency: payout.currency,
    });
    if (holdBalanceMinor < amountMinor) {
      return res.status(409).json({
        ok: false,
        code: "PAYOUT_HOLD_INSUFFICIENT",
        message: "Payout hold balance is insufficient for settlement.",
      });
    }

    // Atomic claim so two concurrent completions can't both pay out.
    const claimed = await Payout.findOneAndUpdate(
      { _id: payout._id, status: { $in: SETTLABLE_PAYOUT_STATUSES } },
      { $set: { status: "PROCESSING" } },
      { new: true }
    );
    if (!claimed) {
      const fresh = await Payout.findById(payout._id).lean();
      if (upper(fresh?.status) === "PAID") {
        return res.json({ ok: true, reused: true, payout: payoutResponse(fresh) });
      }
      return res.status(409).json({
        ok: false,
        code: "PAYOUT_NOT_SETTLABLE",
        message: "This payout is already being settled.",
        payout: fresh ? payoutResponse(fresh) : undefined,
      });
    }

    const lines = [
      {
        direction: "DEBIT",
        accountType: "HOLD_BALANCE",
        accountId: holdAccountId,
        amountMinor,
      },
      {
        direction: "CREDIT",
        accountType: "SYSTEM_ADJUSTMENT",
        accountId: "EXTERNAL_PAYOUT_OUT",
        amountMinor: netAmountMinor,
      },
    ];
    if (feeMinor > 0) {
      lines.push({
        direction: "CREDIT",
        accountType: "PLATFORM_REVENUE",
        accountId: "PLATFORM_DEFAULT",
        amountMinor: feeMinor,
      });
    }

    try {
      await postBalancedLedgerEntries({
        currency: claimed.currency,
        sourceType: "WITHDRAWAL",
        sourceId: claimed.payoutId,
        metadata: { operation: "PAYOUT_COMPLETE", admin: cleanString(requestUserId(req)) },
        lines,
      });
    } catch (postErr) {
      await Payout.updateOne(
        { _id: claimed._id, status: "PROCESSING" },
        { $set: { status } }
      );
      throw postErr;
    }

    claimed.status = "PAID";
    claimed.processedAt = new Date();
    claimed.providerReference = cleanString(
      req.body?.providerReference || `MANUAL_PAYOUT_${Date.now()}`
    );
    claimed.statusTimeline = [
      ...(Array.isArray(claimed.statusTimeline) ? claimed.statusTimeline : []),
      { status: "PAID", at: new Date(), note: "Payout completed by admin", actor: "admin" },
    ];
    await claimed.save();

    return res.json({ ok: true, payout: payoutResponse(claimed) });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to complete payout",
    });
  }
}

export async function adminFailPayout(req, res) {
  try {
    if (!paymentsEnabled()) return serviceUnavailable(res);

    const payoutId = upper(req.params.payoutId);
    const payout = await Payout.findOne({ payoutId });
    if (!payout) return res.status(404).json({ ok: false, message: "Payout not found" });

    const currentStatus = upper(payout.status || "REQUESTED");
    if (["FAILED", "CANCELLED", "REJECTED"].includes(currentStatus)) {
      return res.json({ ok: true, reused: true, payout: payoutResponse(payout) });
    }
    if (currentStatus === "PAID") {
      return res.status(409).json({
        ok: false,
        code: "PAYOUT_ALREADY_PAID",
        message: "Completed payouts cannot be failed.",
      });
    }

    // Atomic claim so the hold-to-owner revert can't be applied twice.
    const claimed = await Payout.findOneAndUpdate(
      { _id: payout._id, status: { $in: SETTLABLE_PAYOUT_STATUSES } },
      { $set: { status: "PROCESSING" } },
      { new: true }
    );
    if (!claimed) {
      const fresh = await Payout.findById(payout._id).lean();
      const freshStatus = upper(fresh?.status || "");
      if (["FAILED", "CANCELLED", "REJECTED"].includes(freshStatus)) {
        return res.json({ ok: true, reused: true, payout: payoutResponse(fresh) });
      }
      return res.status(409).json({
        ok: false,
        code: "PAYOUT_NOT_FAILABLE",
        message: "This payout is already being settled.",
        payout: fresh ? payoutResponse(fresh) : undefined,
      });
    }

    const holdAccountId = payoutHoldAccountId(claimed);
    const holdBalanceMinor = await getLedgerAccountBalanceMinor({
      accountType: "HOLD_BALANCE",
      accountId: holdAccountId,
      currency: claimed.currency,
    });
    const releaseMinor = Math.max(
      0,
      Math.min(holdBalanceMinor, Number(claimed.amountMinor || 0))
    );

    try {
      if (releaseMinor > 0) {
        await postBalancedLedgerEntries({
          currency: claimed.currency,
          sourceType: "WITHDRAWAL",
          sourceId: claimed.payoutId,
          metadata: { operation: "PAYOUT_REVERT", admin: cleanString(requestUserId(req)) },
          lines: [
            {
              direction: "DEBIT",
              accountType: "HOLD_BALANCE",
              accountId: holdAccountId,
              amountMinor: releaseMinor,
            },
            // Route the refund back to the ORIGINAL owner (player wallet or
            // organiser balance) — never the acting admin.
            payoutRevertCreditLine(claimed, releaseMinor),
          ],
        });
      }
    } catch (postErr) {
      await Payout.updateOne(
        { _id: claimed._id, status: "PROCESSING" },
        { $set: { status: currentStatus } }
      );
      throw postErr;
    }

    const requested = upper(req.body?.status || "FAILED");
    claimed.status = ["FAILED", "CANCELLED", "REJECTED"].includes(requested)
      ? requested
      : "FAILED";
    claimed.processedAt = new Date();
    claimed.statusTimeline = [
      ...(Array.isArray(claimed.statusTimeline) ? claimed.statusTimeline : []),
      {
        status: claimed.status,
        at: new Date(),
        note: cleanString(req.body?.reason || "Payout failed; funds returned"),
        actor: "admin",
      },
    ];
    await claimed.save();

    return res.json({ ok: true, payout: payoutResponse(claimed) });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to fail payout",
    });
  }
}

export async function ingestWebhookEvent(req, res) {
  try {
    const provider = upper(req.params.provider || "UNKNOWN");

    // Phase C: reject webhooks from unknown providers before doing any work.
    if (!isKnownWebhookProvider(provider)) {
      return res.status(400).json({
        ok: false,
        code: "UNKNOWN_WEBHOOK_PROVIDER",
        message: "Unknown webhook provider.",
        provider,
      });
    }

    const payload = req.body && typeof req.body === "object" ? req.body : {};

    const providerEventId = cleanString(
      payload.id || payload.eventId || payload.event_id
    );
    const eventType = upper(
      payload.type || payload.eventType || payload.event_type || "UNKNOWN"
    );
    const signature = cleanString(
      req.headers["x-webhook-signature"] ||
        req.headers["x-signature"] ||
        req.headers["mypos-signature"] ||
        ""
    );

    const dedupeKey = buildWebhookDedupeKey({
      provider,
      providerEventId,
      eventType,
      payload,
      signature,
    });

    let existing = await PaymentWebhookEvent.findOne({ dedupeKey });
    if (existing) {
      existing.attempts = Number(existing.attempts || 0) + 1;
      await existing.save();
      return res.status(200).json({
        ok: true,
        duplicate: true,
        accepted: true,
        provider,
        status: upper(existing.status || "RECEIVED"),
        dedupeKey,
      });
    }

    let eventDoc;
    try {
      const initialStatus = paymentsEnabled() ? "RECEIVED" : "IGNORED";
      eventDoc = await PaymentWebhookEvent.create({
        eventId: generatePublicId("WE"),
        provider,
        providerEventId,
        dedupeKey,
        eventType,
        signature,
        sourceIp: cleanString(req.ip),
        headers: req.headers || {},
        payload,
        status: initialStatus,
        attempts: 1,
        processedAt: initialStatus === "IGNORED" ? new Date() : null,
        metadata: {
          reason:
            initialStatus === "IGNORED"
              ? "Feature flag disabled while webhook received"
              : "Webhook captured for processing",
        },
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        existing = await PaymentWebhookEvent.findOne({ dedupeKey });
        if (existing) {
          existing.attempts = Number(existing.attempts || 0) + 1;
          await existing.save();
          return res.status(200).json({
            ok: true,
            duplicate: true,
            accepted: true,
            provider,
            status: upper(existing.status || "RECEIVED"),
            dedupeKey,
          });
        }
      }
      throw createErr;
    }

    if (!paymentsEnabled()) {
      return res.status(202).json({
        ok: true,
        accepted: true,
        provider,
        status: "IGNORED",
        dedupeKey,
      });
    }

    const signatureCheck = verifyWebhookSignature({
      provider,
      payload,
      signature,
      rawBody:
        typeof req.rawBody === "string"
          ? req.rawBody
          : Buffer.isBuffer(req.rawBody)
          ? req.rawBody.toString("utf8")
          : "",
    });

    if (!signatureCheck.verified) {
      eventDoc.status = "FAILED";
      eventDoc.lastError = "Invalid webhook signature";
      eventDoc.processedAt = new Date();
      eventDoc.metadata = {
        ...(eventDoc.metadata && typeof eventDoc.metadata === "object"
          ? eventDoc.metadata
          : {}),
        verification: {
          verified: false,
          reason: signatureCheck.reason,
        },
      };
      await eventDoc.save();
      return res.status(401).json({
        ok: false,
        code: "INVALID_WEBHOOK_SIGNATURE",
        message: "Webhook signature is invalid",
        provider,
      });
    }

    eventDoc.status = "VERIFIED";
    eventDoc.metadata = {
      ...(eventDoc.metadata && typeof eventDoc.metadata === "object"
        ? eventDoc.metadata
        : {}),
      verification: {
        verified: true,
        reason: signatureCheck.reason,
      },
    };
    await eventDoc.save();

    const lookup = extractWebhookIntentLookup(payload);
    const intent = await findPaymentIntentForWebhook({ provider, lookup });
    if (!intent) {
      eventDoc.status = "PROCESSED";
      eventDoc.processedAt = new Date();
      eventDoc.metadata = {
        ...(eventDoc.metadata && typeof eventDoc.metadata === "object"
          ? eventDoc.metadata
          : {}),
        intentMatched: false,
      };
      await eventDoc.save();

      return res.status(202).json({
        ok: true,
        accepted: true,
        provider,
        status: "PROCESSED",
        dedupeKey,
        intentMatched: false,
      });
    }

    await maybeExpireIntent(intent, "webhook");

    const webhookStatus = normalizeProviderStatus(
      statusFromWebhook({ eventType, payload }),
      intent.status
    );

    if (cleanString(lookup.providerPaymentId)) {
      intent.providerPaymentId = cleanString(lookup.providerPaymentId);
    }
    if (cleanString(lookup.providerReference)) {
      intent.providerReference = cleanString(lookup.providerReference);
    }

    if (allowWebhookStatusTransition(intent.status, webhookStatus)) {
      if (upper(intent.status) !== upper(webhookStatus)) {
        appendTimeline(
          intent,
          webhookStatus,
          `Webhook update: ${eventType}`,
          "webhook"
        );
      } else {
        appendTimeline(
          intent,
          intent.status,
          `Webhook received with unchanged status: ${eventType}`,
          "webhook"
        );
      }
    } else {
      appendTimeline(
        intent,
        intent.status,
        `Webhook ignored due to terminal status (${eventType})`,
        "webhook"
      );
    }

    await intent.save();

    let ledgerResult = null;
    if (upper(intent.status) === "PAID") {
      ledgerResult = await applyLedgerRulesForIntent(intent, {
        trigger: "webhook",
        actor: "webhook",
      });
    }

    eventDoc.status = "PROCESSED";
    eventDoc.processedAt = new Date();
    eventDoc.linkedIntentId = intent._id;
    eventDoc.metadata = {
      ...(eventDoc.metadata && typeof eventDoc.metadata === "object"
        ? eventDoc.metadata
        : {}),
      intentMatched: true,
      intentId: intent.intentId,
      appliedStatus: upper(intent.status),
      ledgerApplied: !!ledgerResult?.applied,
      ledgerReused: !!ledgerResult?.reused,
      settlementId: cleanString(ledgerResult?.settlementId),
    };
    await eventDoc.save();

    return res.status(202).json({
      ok: true,
      accepted: true,
      provider,
      status: "PROCESSED",
      dedupeKey,
      intentMatched: true,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to ingest webhook event",
    });
  }
}

// =====================================================================
// myPOS Checkout (Online Payments v1.4) — redirect form + IPN handler
// =====================================================================

function htmlEscape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

// The public https origin myPOS redirects/notifies back to. Prefer an explicit
// env value (Railway is behind a proxy) and fall back to the request host.
function publicBaseUrl(req) {
  const configured = cleanString(
    process.env.MYPOS_RETURN_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.API_PUBLIC_URL
  );
  if (configured) return configured.replace(/\/+$/, "");
  const host = cleanString(req.get?.("host"));
  const proto = cleanString(req.protocol) || "https";
  return host ? `${proto}://${host}` : "";
}

// GET /api/payments/v2/mypos/redirect/:intentId
// Serves an auto-submitting, RSA-signed HTML form that POSTs the purchase to the
// myPOS gateway. Public by design (it is a browser redirect target); the intentId
// is the unguessable token and only OPEN MYPOS intents are ever rendered.
export async function serveMyposCheckoutRedirect(req, res) {
  try {
    if (!paymentsEnabled()) {
      return res.status(503).type("text/plain").send("Payments are not enabled.");
    }
    if (!hasMyPosConfig()) {
      return res.status(503).type("text/plain").send("myPOS is not configured.");
    }

    const intentId = upper(req.params.intentId);
    const intent = await PaymentIntent.findOne({ intentId });
    if (!intent) {
      return res.status(404).type("text/plain").send("Payment not found.");
    }
    if (upper(intent.provider) !== "MYPOS") {
      return res.status(409).type("text/plain").send("Payment is not a myPOS payment.");
    }
    await maybeExpireIntent(intent, "mypos_redirect");
    if (!OPEN_INTENT_STATUSES.includes(upper(intent.status))) {
      return res
        .status(409)
        .type("text/plain")
        .send(`Payment can no longer be paid (status ${upper(intent.status)}).`);
    }

    const base = publicBaseUrl(req);
    const urls = {
      okUrl: `${base}/api/payments/v2/mypos/return?status=ok&order=${encodeURIComponent(intentId)}`,
      cancelUrl: `${base}/api/payments/v2/mypos/return?status=cancel&order=${encodeURIComponent(intentId)}`,
      notifyUrl: `${base}/api/payments/v2/mypos/notify`,
    };

    const { action, fields } = buildPurchaseForm({ intent, urls });

    // Mark that checkout was launched (does not change lifecycle status).
    appendTimeline(intent, intent.status, "myPOS checkout form served", "provider");
    await intent.save();

    const inputs = Object.entries(fields)
      .map(
        ([k, v]) =>
          `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}" />`
      )
      .join("\n      ");

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting to secure payment…</title>
  </head>
  <body onload="document.forms[0].submit()" style="font-family:sans-serif;text-align:center;padding:2rem;">
    <p>Redirecting you to the secure myPOS payment page…</p>
    <form method="post" action="${htmlEscape(action)}">
      ${inputs}
      <noscript><button type="submit">Continue to payment</button></noscript>
    </form>
  </body>
</html>`;

    res.set("Cache-Control", "no-store");
    return res.status(200).type("text/html").send(html);
  } catch (e) {
    return res
      .status(500)
      .type("text/plain")
      .send("Failed to start payment: " + (e?.message || "unknown error"));
  }
}

// POST /api/payments/v2/mypos/notify
// The authoritative payment result. myPOS POSTs IPCPurchaseNotify form fields
// (incl. its Signature). We verify against the myPOS public cert, then settle the
// matched intent idempotently via the shared ledger machinery. Always ack with a
// plain "OK" so myPOS stops retrying a handled notification.
export async function handleMyposNotify(req, res) {
  try {
    // If payments are disabled we still 200-ack so myPOS doesn't hammer retries,
    // but we do nothing.
    if (!paymentsEnabled() || !hasMyPosConfig()) {
      return res.status(200).type("text/plain").send("OK");
    }

    const fields = req.body && typeof req.body === "object" ? req.body : {};

    if (!verifyNotification(fields)) {
      return res
        .status(401)
        .type("text/plain")
        .send("INVALID_SIGNATURE");
    }

    const orderId = upper(fields.OrderID);
    if (!orderId) {
      return res.status(200).type("text/plain").send("OK");
    }

    const intent = await PaymentIntent.findOne({ intentId: orderId });
    if (!intent) {
      // Unknown order — ack so myPOS stops retrying; nothing to settle.
      return res.status(200).type("text/plain").send("OK");
    }
    if (upper(intent.provider) !== "MYPOS") {
      return res.status(200).type("text/plain").send("OK");
    }

    // Record the gateway transaction reference if provided.
    const trnRef = cleanString(fields.IPC_Trnref || fields.IPCTrnRef);
    if (trnRef) intent.providerReference = trnRef;

    const nextStatus = normalizeProviderStatus(notificationStatus(fields), intent.status);

    if (allowWebhookStatusTransition(intent.status, nextStatus)) {
      if (upper(intent.status) !== upper(nextStatus)) {
        appendTimeline(intent, nextStatus, "myPOS IPN update", "webhook");
      } else {
        appendTimeline(intent, intent.status, "myPOS IPN (unchanged)", "webhook");
      }
    } else {
      appendTimeline(
        intent,
        intent.status,
        "myPOS IPN ignored (terminal status)",
        "webhook"
      );
    }
    await intent.save();

    if (upper(intent.status) === "PAID") {
      await applyLedgerRulesForIntent(intent, { trigger: "mypos_ipn", actor: "webhook" });
    }

    return res.status(200).type("text/plain").send("OK");
  } catch (e) {
    // Do NOT ack on an internal error — let myPOS retry.
    return res
      .status(500)
      .type("text/plain")
      .send("ERROR: " + (e?.message || "unknown"));
  }
}

// GET /api/payments/v2/mypos/return
// Lightweight hosted landing page for URL_OK / URL_Cancel. The app's webview
// detects this URL to close the sheet; the real settlement already happened via
// the IPN, so this page is purely informational.
export function serveMyposReturn(req, res) {
  const status = upper(req.query.status) === "OK" ? "OK" : "CANCEL";
  const paid = status === "OK";
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${paid ? "Payment received" : "Payment cancelled"}</title></head>
  <body style="font-family:sans-serif;text-align:center;padding:2rem;">
    <h2>${paid ? "✅ Payment received" : "Payment cancelled"}</h2>
    <p>${paid ? "You can return to the app now." : "No payment was taken. You can close this page."}</p>
  </body>
</html>`;
  res.set("Cache-Control", "no-store");
  return res.status(200).type("text/html").send(html);
}

// =====================================================================
// myPOS Mobile Checkout SDK (native in-app card entry) — config + confirm
// =====================================================================
//
// The native SDK (Android/iOS) signs and charges the card ON THE DEVICE, so the
// app needs the merchant init parameters (incl. the merchant private key — this
// is inherent to the myPOS mobile SDK design, which performs on-device signing).
// After a successful native charge the app calls the confirm endpoint below to
// settle the matching PaymentIntent through the same idempotent ledger machinery
// the webhook uses.

// GET /api/payments/v2/mypos/mobile-config  (auth required)
// Returns the myPOS Mobile SDK init parameters. Gated on payments being enabled
// and PAYMENTS_PROVIDER=MYPOS so nothing leaks when the provider is inactive.
export async function getMyposMobileConfig(req, res) {
  try {
    if (!paymentsEnabled()) {
      return res.status(503).json({ ok: false, code: "PAYMENTS_DISABLED", message: "Payments are not enabled." });
    }
    if (providerName() !== "MYPOS" || !hasMyPosConfig()) {
      return res.status(503).json({ ok: false, code: "MYPOS_NOT_CONFIGURED", message: "myPOS is not configured." });
    }
    const c = myposConfig();
    return res.status(200).json({
      ok: true,
      config: {
        sid: c.sid,
        walletNumber: c.walletNumber,
        currency: myposMobileCurrency(),
        keyIndex: Number(c.keyIndex || 1) || 1,
        language: c.lang || "EN",
        isSandbox: c.environment !== "PRODUCTION",
        privateKey: c.privateKey,
        publicKey: c.publicCert,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load myPOS mobile config" });
  }
}

// POST /api/payments/v2/mypos/mobile/confirm  (auth required)
// Body: { intentId, transactionReference, status }
// Called by the app after the native SDK returns. On success it marks the
// caller-owned MYPOS intent PAID (idempotently) and applies the ledger rules
// (which credit a wallet top-up or complete a tournament-entry settlement).
//
// NOTE: this trusts the SDK's on-device result. Production hardening = verify
// the transaction server-side via myPOS IPCGetTransactionStatus before settling.
export async function confirmMyposMobilePayment(req, res) {
  try {
    if (!paymentsEnabled()) {
      return res.status(503).json({ ok: false, code: "PAYMENTS_DISABLED", message: "Payments are not enabled." });
    }
    const intentId = upper(req.body?.intentId || req.body?.orderId);
    const transactionReference = cleanString(req.body?.transactionReference);
    const success = upper(req.body?.status || "SUCCESS") === "SUCCESS";
    if (!intentId) {
      return res.status(400).json({ ok: false, code: "MISSING_INTENT", message: "intentId is required." });
    }

    const intent = await PaymentIntent.findOne({ intentId });
    if (!intent) {
      return res.status(404).json({ ok: false, code: "INTENT_NOT_FOUND", message: "Payment not found." });
    }
    // Ownership: the intent must belong to the authenticated caller.
    const callerId = cleanString(requestUserId(req));
    if (callerId && cleanString(intent.userId) !== callerId) {
      return res.status(403).json({ ok: false, code: "NOT_OWNER", message: "This payment isn't yours." });
    }
    if (upper(intent.provider) !== "MYPOS") {
      return res.status(409).json({ ok: false, code: "WRONG_PROVIDER", message: "Not a myPOS payment." });
    }

    if (transactionReference) intent.providerReference = transactionReference;

    if (!success) {
      appendTimeline(intent, intent.status, "myPOS mobile payment failed/cancelled", "app");
      await intent.save();
      return res.status(200).json({ ok: true, intent: paymentIntentResponse(intent), settled: false });
    }

    const nextStatus = normalizeProviderStatus("PAID", intent.status);
    if (allowWebhookStatusTransition(intent.status, nextStatus)) {
      appendTimeline(intent, nextStatus, "myPOS mobile payment confirmed", "app");
      await intent.save();
    }

    let ledgerResult = null;
    if (upper(intent.status) === "PAID") {
      ledgerResult = await applyLedgerRulesForIntent(intent, { trigger: "mypos_mobile", actor: "app" });
    }

    return res.status(200).json({
      ok: true,
      intent: paymentIntentResponse(intent),
      settled: !!ledgerResult?.applied,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to confirm myPOS mobile payment" });
  }
}
