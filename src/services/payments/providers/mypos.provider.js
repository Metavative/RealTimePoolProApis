function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function hasMyPosConfig() {
  return Boolean(
    cleanString(process.env.MYPOS_PARTNER_CLIENT_ID) &&
      cleanString(process.env.MYPOS_PARTNER_SECRET) &&
      cleanString(process.env.MYPOS_MERCHANT_CLIENT_ID) &&
      cleanString(process.env.MYPOS_MERCHANT_SECRET) &&
      cleanString(process.env.MYPOS_PARTNER_ID) &&
      cleanString(process.env.MYPOS_APPLICATION_ID)
  );
}

function notConfiguredError() {
  const err = new Error("myPOS is not configured yet");
  err.code = "MYPOS_NOT_CONFIGURED";
  return err;
}

export function createMyPosPaymentProvider() {
  return {
    name: "MYPOS",

    async createCheckoutSession() {
      if (!hasMyPosConfig()) {
        throw notConfiguredError();
      }
      const err = new Error("myPOS adapter is prepared but not activated yet");
      err.code = "MYPOS_NOT_IMPLEMENTED";
      throw err;
    },

    async confirmPayment() {
      if (!hasMyPosConfig()) {
        throw notConfiguredError();
      }
      const err = new Error("myPOS confirmation will be processed via verified webhooks");
      err.code = "MYPOS_CONFIRMATION_VIA_WEBHOOK";
      throw err;
    },

    async cancelPayment() {
      if (!hasMyPosConfig()) {
        throw notConfiguredError();
      }
      const err = new Error("myPOS cancellation is not active yet");
      err.code = "MYPOS_CANCEL_NOT_IMPLEMENTED";
      throw err;
    },

    async fetchPaymentStatus() {
      if (!hasMyPosConfig()) {
        throw notConfiguredError();
      }
      return { status: upper("PENDING_PAYMENT") };
    },
  };
}

