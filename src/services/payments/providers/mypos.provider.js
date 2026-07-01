// src/services/payments/providers/mypos.provider.js
//
// myPOS Checkout (Online Payments v1.4) provider — hosted card gateway used for
// entry fees and wallet top-ups.
//
// Flow (see also the redirect route + IPN handler in payments.controller.js):
//   1. createCheckoutSession() returns a BACKEND redirect URL as the intent's
//      checkoutUrl. The app opens it in a webview.
//   2. GET /api/payments/v2/mypos/redirect/:intentId serves an auto-submitting,
//      RSA-signed HTML form that POSTs to the myPOS gateway (built here via
//      buildPurchaseForm()).
//   3. myPOS charges the card and POSTs an IPCPurchaseNotify (IPN) to
//      URL_Notify. The IPN handler verifies the signature (verifyNotification())
//      and settles the intent. The browser redirect to URL_OK/URL_Cancel is only
//      UX — the IPN is authoritative.
//
// Everything except live network calls (refund/status) and the real credentials
// can be exercised without a myPOS account; the signing is unit-tested with a
// throwaway keypair.

import { signValues, verifyValues } from "./mypos.signing.js";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

// ---- configuration -------------------------------------------------------
// NOTE: these REPLACE the old Partner/OAuth vars — Checkout needs different
// credentials entirely (a merchant wallet + RSA keypair, not an OAuth client).

export function myposConfig() {
  return {
    walletNumber: cleanString(process.env.MYPOS_WALLET_NUMBER),
    sid: cleanString(process.env.MYPOS_SID),
    keyIndex: cleanString(process.env.MYPOS_KEY_INDEX, "1"),
    privateKey: normalizePem(process.env.MYPOS_PRIVATE_KEY),
    publicCert: normalizePem(process.env.MYPOS_PUBLIC_CERT),
    environment: upper(process.env.MYPOS_ENVIRONMENT, "TEST"),
    lang: upper(process.env.MYPOS_LANGUAGE, "EN"),
  };
}

// Env vars can't hold real newlines, so PEMs are usually stored with literal "\n"
// escapes. Restore them so Node's crypto accepts the key.
function normalizePem(v) {
  const raw = cleanString(v);
  if (!raw) return "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export function hasMyPosConfig() {
  const c = myposConfig();
  return Boolean(c.walletNumber && c.sid && c.keyIndex && c.privateKey);
}

// The gateway endpoint the signed form POSTs to. Sandbox vs production is chosen
// purely by MYPOS_ENVIRONMENT so no code change is needed to go live.
export function myposGatewayUrl() {
  return myposConfig().environment === "PRODUCTION"
    ? "https://www.mypos.com/vmp/checkout"
    : "https://www.mypos.com/vmp/checkout-test";
}

function notConfiguredError() {
  const err = new Error("myPOS is not configured yet");
  err.code = "MYPOS_NOT_CONFIGURED";
  return err;
}

function amountToDecimalString(amountMinor) {
  const minor = Math.max(0, Math.floor(Number(amountMinor) || 0));
  return (minor / 100).toFixed(2);
}

// ---- purchase form -------------------------------------------------------
//
// The ORDER of these keys is the order myPOS concatenates values to build the
// signature, so it must match the myPOS Checkout v1.4 request spec exactly.
// It is centralised here as the single place to confirm/adjust against the
// sandbox during activation. Cart-item fields (Article_1.. etc.) are appended
// in index order after CartItems, which is where myPOS expects them.
const PURCHASE_FIELD_ORDER = [
  "IPCmethod",
  "IPCVersion",
  "IPCLanguage",
  "SID",
  "WalletNumber",
  "KeyIndex",
  "Source",
  "Amount",
  "Currency",
  "OrderID",
  "URL_OK",
  "URL_Cancel",
  "URL_Notify",
  "CardTokenRequest",
  "PaymentParametersRequired",
  "CartItems",
];

// Build the fully-signed set of hidden form fields for an intent. `urls` carries
// the public https return/notify endpoints (built by the redirect route from the
// deployment's base URL). Returns { action, fields } — `fields` includes the
// Signature and is ready to render as an auto-submitting form.
export function buildPurchaseForm({ intent, urls }) {
  if (!hasMyPosConfig()) throw notConfiguredError();
  const c = myposConfig();
  const orderId = cleanString(intent?.intentId);
  if (!orderId) {
    const err = new Error("myPOS purchase requires an intent id");
    err.code = "MYPOS_INVALID_INTENT";
    throw err;
  }

  const amount = amountToDecimalString(intent?.amountMinor);
  const currency = upper(intent?.currency, "GBP");

  // Single cart line describing the purchase (myPOS requires at least one item).
  const itemName = cleanString(intent?.metadata?.description) || `Order ${orderId}`;
  const item = {
    Article_1: itemName.slice(0, 255),
    Quantity_1: "1",
    Price_1: amount,
    Amount_1: amount,
    Currency_1: currency,
  };

  const base = {
    IPCmethod: "IPCPurchase",
    IPCVersion: "1.4",
    IPCLanguage: c.lang || "EN",
    SID: c.sid,
    WalletNumber: c.walletNumber,
    KeyIndex: c.keyIndex,
    Source: "Online",
    Amount: amount,
    Currency: currency,
    OrderID: orderId,
    URL_OK: cleanString(urls?.okUrl),
    URL_Cancel: cleanString(urls?.cancelUrl),
    URL_Notify: cleanString(urls?.notifyUrl),
    CardTokenRequest: "0",
    PaymentParametersRequired: "1",
    CartItems: "1",
  };

  // Values in signature order: the base fields, then the cart-item fields.
  const orderedValues = [
    ...PURCHASE_FIELD_ORDER.map((k) => base[k]),
    item.Article_1,
    item.Quantity_1,
    item.Price_1,
    item.Amount_1,
    item.Currency_1,
  ];

  const Signature = signValues(orderedValues, c.privateKey);

  return {
    action: myposGatewayUrl(),
    fields: { ...base, ...item, Signature },
  };
}

// ---- IPN verification ----------------------------------------------------
//
// myPOS POSTs IPCPurchaseNotify as form fields including its own Signature. We
// verify by rebuilding the concatenation from the posted values (excluding
// Signature) in the documented notify order and checking it against the myPOS
// public certificate.
//
// The exact IPN field order below is per the v1.4 notification spec and is the
// one thing that must be confirmed against a live sandbox notification during
// activation (the crypto around it is verified by unit tests).
const NOTIFY_FIELD_ORDER = [
  "IPCmethod",
  "IPCVersion",
  "IPCLanguage",
  "SID",
  "WalletNumber",
  "KeyIndex",
  "Amount",
  "Currency",
  "OrderID",
  "IPC_Trnref",
];

export function verifyNotification(fields = {}) {
  if (!myposConfig().publicCert) throw notConfiguredError();
  const orderedValues = NOTIFY_FIELD_ORDER.map((k) => cleanString(fields[k]));
  const signature = cleanString(fields.Signature);
  return verifyValues(orderedValues, signature, myposConfig().publicCert);
}

// Map a myPOS IPN to our intent lifecycle status. IPCPurchaseNotify carries a
// Status/PurchaseStatus; anything non-successful is treated as failed.
export function notificationStatus(fields = {}) {
  const status = upper(fields?.Status ?? fields?.PurchaseStatus ?? "");
  // myPOS uses "0"/"success" style codes; be permissive but conservative.
  if (status === "0" || status === "SUCCESS" || status === "PAID" || status === "COMPLETED") {
    return "PAID";
  }
  if (status === "CANCELLED" || status === "CANCELED") return "CANCELLED";
  if (!status) return "PENDING_PAYMENT";
  return "FAILED";
}

export function createMyPosPaymentProvider() {
  return {
    name: "MYPOS",

    // The checkoutUrl we hand back is our OWN redirect route; the signed gateway
    // form is served there (buildPurchaseForm needs the request's base URL for
    // the return/notify endpoints, which the controller supplies).
    async createCheckoutSession({ intent }) {
      if (!hasMyPosConfig()) throw notConfiguredError();
      const intentId = cleanString(intent?.intentId);
      return {
        providerPaymentId: cleanString(intent?.providerPaymentId) || `MYPOS_${intentId}`,
        providerReference: "",
        checkoutUrl: `/api/payments/v2/mypos/redirect/${encodeURIComponent(intentId)}`,
        status: "PENDING_PAYMENT",
      };
    },

    // Card confirmation is asynchronous — it arrives via the verified IPN, never
    // a synchronous confirm call.
    async confirmPayment() {
      if (!hasMyPosConfig()) throw notConfiguredError();
      const err = new Error("myPOS confirmation is processed via verified IPN webhooks");
      err.code = "MYPOS_CONFIRMATION_VIA_WEBHOOK";
      throw err;
    },

    async cancelPayment() {
      if (!hasMyPosConfig()) throw notConfiguredError();
      const err = new Error("myPOS cancellation is not active yet");
      err.code = "MYPOS_CANCEL_NOT_IMPLEMENTED";
      throw err;
    },

    // Server-to-server IPCRefund. The request is built and signed here; the
    // actual gateway call requires live credentials + endpoint confirmation, so
    // it throws NOT_CONFIGURED until MYPOS_* creds are present. The signing path
    // mirrors the purchase request and is covered by unit tests.
    async refundPayment({ intent, amountMinor, currency, idempotencyKey }) {
      if (!hasMyPosConfig()) throw notConfiguredError();
      const c = myposConfig();
      const orderId = cleanString(intent?.intentId);
      const amount = amountToDecimalString(amountMinor ?? intent?.amountMinor);
      const cur = upper(currency || intent?.currency, "GBP");
      const trnRef = cleanString(intent?.providerReference || intent?.providerPaymentId);

      const orderedValues = [
        "IPCRefund",
        "1.4",
        c.sid,
        c.walletNumber,
        c.keyIndex,
        cleanString(idempotencyKey) || `REFUND_${orderId}`,
        trnRef,
        amount,
        cur,
      ];
      const signature = signValues(orderedValues, c.privateKey);

      const params = {
        IPCmethod: "IPCRefund",
        IPCVersion: "1.4",
        SID: c.sid,
        WalletNumber: c.walletNumber,
        KeyIndex: c.keyIndex,
        OrderID: cleanString(idempotencyKey) || `REFUND_${orderId}`,
        IPC_Trnref: trnRef,
        Amount: amount,
        Currency: cur,
        Signature: signature,
      };

      const res = await fetch(myposGatewayUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
      const text = await res.text();
      // myPOS returns an XML/urlencoded body; success detection must be confirmed
      // against sandbox. Treat a 2xx with a success marker as refunded.
      const ok = res.ok && /status[^0-9-]*0|success/i.test(text);
      if (!ok) {
        const err = new Error("myPOS refund was not accepted by the gateway");
        err.code = "MYPOS_REFUND_REJECTED";
        err.detail = text.slice(0, 500);
        throw err;
      }
      return {
        status: "REFUNDED",
        providerRefundId: params.OrderID,
        providerReference: trnRef,
        providerPaymentId: cleanString(intent?.providerPaymentId),
        amountMinor: Math.max(0, Math.floor(Number(amountMinor) || 0)),
        currency: cur,
      };
    },

    async fetchPaymentStatus({ intent }) {
      if (!hasMyPosConfig()) throw notConfiguredError();
      return {
        status: upper(intent?.status || "PENDING_PAYMENT"),
        providerPaymentId: cleanString(intent?.providerPaymentId) || `MYPOS_${cleanString(intent?.intentId)}`,
      };
    },
  };
}
