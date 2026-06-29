function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function mockCheckoutUrl(intentId) {
  return `/api/payments/v2/mock/checkout/${encodeURIComponent(intentId)}`;
}

export function createMockPaymentProvider() {
  return {
    name: "MOCK",

    async createCheckoutSession({ intent, successUrl }) {
      const intentId = cleanString(intent?.intentId);
      const providerPaymentId =
        cleanString(intent?.providerPaymentId) || `MOCK_PAY_${intentId}`;
      const providerReference = `MOCK_REF_${Date.now()}`;

      return {
        providerPaymentId,
        providerReference,
        checkoutUrl: cleanString(successUrl) || mockCheckoutUrl(intentId),
        clientToken: `mock_client_${intentId}`,
        status: "PENDING_PAYMENT",
      };
    },

    async confirmPayment({ intent, payload }) {
      const requested = upper(payload?.status || payload?.outcome || "PAID");
      const resolved = ["PAID", "FAILED", "CANCELLED"].includes(requested)
        ? requested
        : "PAID";

      return {
        status: resolved,
        providerReference: `MOCK_CONFIRM_${Date.now()}`,
        providerPaymentId:
          cleanString(intent?.providerPaymentId) ||
          `MOCK_PAY_${cleanString(intent?.intentId)}`,
      };
    },

    async cancelPayment({ intent }) {
      return {
        status: "CANCELLED",
        providerReference: `MOCK_CANCEL_${Date.now()}`,
        providerPaymentId:
          cleanString(intent?.providerPaymentId) ||
          `MOCK_PAY_${cleanString(intent?.intentId)}`,
      };
    },

    async refundPayment({ intent, amountMinor, currency, idempotencyKey }) {
      const intentId = cleanString(intent?.intentId);
      const providerPaymentId =
        cleanString(intent?.providerPaymentId) || `MOCK_PAY_${intentId}`;
      // The idempotency key (REFUND_<intentId>) doubles as the synthetic refund
      // id so repeated calls for the same charge resolve to the same id.
      const providerRefundId =
        cleanString(idempotencyKey) || `MOCK_REFUND_${intentId}`;
      return {
        status: "REFUNDED",
        providerRefundId,
        providerReference: `MOCK_REFUND_${Date.now()}`,
        providerPaymentId,
        amountMinor: Math.max(0, Math.floor(Number(amountMinor) || 0)),
        currency: upper(currency || intent?.currency || "GBP"),
      };
    },

    async fetchPaymentStatus({ intent }) {
      return {
        status: upper(intent?.status || "PENDING_PAYMENT"),
        providerPaymentId:
          cleanString(intent?.providerPaymentId) ||
          `MOCK_PAY_${cleanString(intent?.intentId)}`,
      };
    },
  };
}

