import crypto from "node:crypto";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function slowThresholdMs() {
  const raw = Number(process.env.SLOW_REQUEST_THRESHOLD_MS || 1200);
  if (!Number.isFinite(raw)) return 1200;
  return Math.max(250, Math.min(15000, Math.floor(raw)));
}

function shouldLogSlowRequests() {
  return boolFromEnv("LOG_SLOW_REQUESTS", true);
}

function randomRequestId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `req_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

export function requestContextMiddleware(req, res, next) {
  const incoming = cleanString(req.headers["x-request-id"]);
  const requestId = incoming || randomRequestId();
  req.requestId = requestId;
  req.requestStartedAtMs = Date.now();
  res.set("X-Request-Id", requestId);

  res.on("finish", () => {
    if (!shouldLogSlowRequests()) return;
    const elapsed = Date.now() - Number(req.requestStartedAtMs || Date.now());
    if (elapsed >= slowThresholdMs()) {
      console.warn(`[SLOW_REQUEST] ${requestId} ${req.method} ${req.originalUrl} ${elapsed}ms`);
    }
  });

  return next();
}

export function notFoundHandler(req, res) {
  return res.status(404).json({
    ok: false,
    code: "NOT_FOUND",
    message: "Route not found",
    requestId: cleanString(req.requestId),
  });
}
