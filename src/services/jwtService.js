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

export function sign(payload, expiresIn) {
  if (!payload || typeof payload !== "object") {
    throw new Error("JWT payload must be an object");
  }
  return jwt.sign(payload, getSecret(), {
    expiresIn: expiresIn || getExpires(),
  });
}

export function verify(token) {
  if (!token) {
    throw new Error("JWT token required");
  }
  return jwt.verify(token, getSecret());
}
