// src/services/payments/providers/mypos.signing.js
//
// Pure signing/verification helpers for the myPOS Checkout (Online Payments
// v1.4) gateway. Kept dependency-free (only Node's built-in crypto) and side
// effect free so they can be unit-tested with a throwaway RSA keypair — no myPOS
// account or network access required.
//
// myPOS signing scheme (from developers.mypos.com):
//   concatenated = implode('-', values_in_submission_order)
//   dataToSign   = base64(concatenated)
//   Signature    = base64( RSA-SHA256(dataToSign) )   // signed with the RSA key
//
// The OUTGOING purchase request is signed with the MERCHANT private key. The
// INCOMING IPCPurchaseNotify (IPN) is signed by myPOS and verified with the
// myPOS PUBLIC certificate. Both use the identical concatenation rule; only the
// key differs, so one pair of helpers covers both directions.

import crypto from "crypto";

// Build the exact string that gets signed/verified: base64 of the field values
// joined by "-". Values are coerced to strings in the order given; ORDER MATTERS
// and must match the order the counterparty used.
export function buildSignatureBase(orderedValues) {
  const joined = (Array.isArray(orderedValues) ? orderedValues : [])
    .map((v) => (v === null || v === undefined ? "" : String(v)))
    .join("-");
  return Buffer.from(joined, "utf8").toString("base64");
}

// Sign the ordered values with a merchant RSA private key (PEM). Returns the
// base64 signature myPOS expects in the `Signature` field.
export function signValues(orderedValues, privateKeyPem) {
  const key = String(privateKeyPem || "").trim();
  if (!key) {
    const err = new Error("myPOS private key is missing");
    err.code = "MYPOS_NOT_CONFIGURED";
    throw err;
  }
  // Normalise to a KeyObject first. myPOS issues PKCS#1 keys
  // (-----BEGIN RSA PRIVATE KEY-----), which OpenSSL 3 will not decode when
  // handed as a raw PEM string to sign(); createPrivateKey accepts PKCS#1 and
  // PKCS#8 alike and yields a KeyObject sign() always accepts.
  const keyObject = crypto.createPrivateKey(key);
  const base = buildSignatureBase(orderedValues);
  return crypto.createSign("RSA-SHA256").update(base).sign(keyObject, "base64");
}

// Verify a base64 signature over the ordered values against the myPOS public
// certificate (PEM). Returns a boolean; never throws on a bad signature (only on
// missing config), so callers can branch cleanly.
export function verifyValues(orderedValues, signatureBase64, publicCertPem) {
  const cert = String(publicCertPem || "").trim();
  if (!cert) {
    const err = new Error("myPOS public certificate is missing");
    err.code = "MYPOS_NOT_CONFIGURED";
    throw err;
  }
  const sig = String(signatureBase64 || "").trim();
  if (!sig) return false;
  const base = buildSignatureBase(orderedValues);
  try {
    // createPublicKey accepts both a bare public key and an X.509 certificate
    // (myPOS ships a certificate), and normalises PKCS#1 the same way as above.
    const keyObject = crypto.createPublicKey(cert);
    return crypto.createVerify("RSA-SHA256").update(base).verify(keyObject, sig, "base64");
  } catch {
    // Malformed signature / key → treat as unverified rather than crashing the
    // IPN handler (an attacker could otherwise DoS with garbage signatures).
    return false;
  }
}
