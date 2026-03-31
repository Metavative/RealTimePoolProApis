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

