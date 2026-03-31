import { createMockPaymentProvider } from "./providers/mock.provider.js";
import { createMyPosPaymentProvider } from "./providers/mypos.provider.js";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

export function resolvePaymentProvider(name) {
  const provider = upper(name, "MOCK");
  if (provider === "MYPOS") {
    return createMyPosPaymentProvider();
  }
  return createMockPaymentProvider();
}

