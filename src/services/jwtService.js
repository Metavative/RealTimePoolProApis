import jwt from "jsonwebtoken";

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is missing");
  }
  return secret;
}

function getExpires() {
  const v = process.env.JWT_EXPIRES;
  return v && String(v).trim() ? String(v).trim() : "7d";
}

// Pin the signing algorithm on both sign and verify. Without an explicit
// allow-list, jwt.verify accepts any algorithm named in the token header, which
// (combined with a leaked public key, or the "none" alg) is a classic JWT
// bypass. We only ever issue HS256 tokens, so lock verification to HS256.
const JWT_ALGORITHM = "HS256";

export function sign(payload, expiresIn) {
  if (!payload || typeof payload !== "object") {
    throw new Error("JWT payload must be an object");
  }
  return jwt.sign(payload, getSecret(), {
    expiresIn: expiresIn || getExpires(),
    algorithm: JWT_ALGORITHM,
  });
}

export function verify(token) {
  if (!token) {
    throw new Error("JWT token required");
  }
  return jwt.verify(token, getSecret(), { algorithms: [JWT_ALGORITHM] });
}

// Fail fast at startup if auth is misconfigured, instead of only erroring on
// the first token operation at runtime. Call this during server boot.
export function assertAuthConfig() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !String(secret).trim()) {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start: all authentication would be insecure."
    );
  }
  if (String(secret).trim().length < 16) {
    // Non-fatal, but loudly flagged.
    console.warn(
      "⚠️  JWT_SECRET is shorter than 16 characters — use a long, random secret in production."
    );
  }
  return true;
}
