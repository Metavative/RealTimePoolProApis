// services/socket_handler/socketAuth.js
//
// Phase 0 — Socket.io handshake authentication.
//
// Previously every socket handler trusted a client-supplied `userId`, which let
// any client overwrite another user's presence/location or push fake match
// events. The Flutter client already sends the JWT in the handshake (both
// `auth.token` and the Authorization header), so verifying it here is fully
// backwards-compatible.
//
// Behaviour:
//   - If a valid token is present, `socket.authUserId` is pinned to the token's
//     subject. Handlers should prefer this over any client-supplied id.
//   - If SOCKET_AUTH_REQUIRED=true, connections without a valid token are
//     rejected. Default is off so existing/legacy clients keep working while
//     the authenticated id is still enforced whenever a token is supplied.

import { verify } from "../jwtService.js";

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function socketAuthRequired() {
  return envFlag("SOCKET_AUTH_REQUIRED", false);
}

function extractToken(socket) {
  const auth = socket?.handshake?.auth || {};
  if (auth.token && String(auth.token).trim()) {
    return String(auth.token).trim();
  }

  const headers = socket?.handshake?.headers || {};
  const header = headers.authorization || headers.Authorization;
  if (header) {
    const parts = String(header).trim().split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      return parts[1];
    }
    if (parts.length === 1 && parts[0]) {
      return parts[0];
    }
  }

  // Some clients pass it as a query param.
  const query = socket?.handshake?.query || {};
  if (query.token && String(query.token).trim()) {
    return String(query.token).trim();
  }

  return null;
}

// io.use(...) middleware.
export function socketAuthMiddleware(socket, next) {
  const required = socketAuthRequired();
  const token = extractToken(socket);

  if (!token) {
    if (required) {
      return next(new Error("UNAUTHORIZED: missing token"));
    }
    return next();
  }

  try {
    const payload = verify(token);
    const id = payload?.id ? String(payload.id) : "";
    if (!id) {
      if (required) return next(new Error("UNAUTHORIZED: invalid token payload"));
      return next();
    }

    // Pin the authenticated identity to the socket.
    socket.authUserId = id;
    socket.authTokenRole = String(payload.role || "").toUpperCase();
    socket.authTokenType = String(payload.typ || "").toLowerCase();
    return next();
  } catch (e) {
    if (required) {
      return next(new Error("UNAUTHORIZED: invalid or expired token"));
    }
    // Soft mode: ignore a bad token and fall back to legacy behaviour.
    return next();
  }
}

// Resolve the effective user id for a handler. When the socket is
// authenticated, the token identity always wins over a client-supplied id
// (prevents spoofing). When not authenticated, fall back to the claimed id
// unless auth is required.
export function resolveUserId(socket, claimedId) {
  if (socket?.authUserId) return socket.authUserId;
  if (socketAuthRequired()) return null;
  const claimed = claimedId ? String(claimedId) : "";
  return claimed || null;
}

export default { socketAuthMiddleware, socketAuthRequired, resolveUserId };
