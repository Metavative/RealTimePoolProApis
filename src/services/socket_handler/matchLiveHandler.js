// services/socket_handler/matchLiveHandler.js
//
// Phase B2: real-time LIVE SCORING + multi-device sync.
//
// Clients watch a match room (`match:<id>`) and receive `match:score:update`
// events whenever a participant pushes a new score. This keeps spectators and a
// player's own multiple devices in sync during play. It is a TRANSIENT relay:
// the authoritative result/settlement is still recorded via the HTTP endpoints
// (finishMatch / tournament match patch). Live updates are advisory overlays.
//
// Authority:
//   - Only authenticated sockets may push scores (anti-anonymous-spoof) unless
//     auth is globally disabled (legacy soft mode).
//   - For 1v1 matches (Mongo ObjectId ids) we verify the sender is one of the
//     match.players before broadcasting. For tournament/custom match ids we
//     require authentication and attribute the update with `by`.

import mongoose from "mongoose";
import Match from "../../models/match.model.js";
import { socketAuthRequired } from "./socketAuth.js";

function matchIdOf(payload) {
  const raw = payload?.matchId ?? payload?.id;
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  return s;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Pure builder for the broadcast payload. Exported for unit testing.
export function buildScoreUpdate(payload = {}, senderId = "", at = 0) {
  return {
    matchId: matchIdOf(payload),
    scoreA: numOrNull(payload?.scoreA),
    scoreB: numOrNull(payload?.scoreB),
    frame: payload?.frame ?? null,
    note:
      typeof payload?.note === "string" ? payload.note.slice(0, 200) : null,
    by: senderId ? String(senderId) : null,
    at: at || null,
  };
}

// Resolves whether `senderId` is allowed to push a score for `matchId`.
// Returns { ok: boolean, reason?: string }. Exported for unit testing.
export async function authorizeScorePush(matchId, senderId, deps = {}) {
  const authRequired =
    typeof deps.socketAuthRequired === "function"
      ? deps.socketAuthRequired()
      : socketAuthRequired();
  const MatchModel = deps.Match || Match;
  const isValidObjectId =
    deps.isValidObjectId || mongoose.isValidObjectId.bind(mongoose);

  if (!matchId) return { ok: false, reason: "NO_MATCH_ID" };

  // Anonymous push only allowed in legacy soft mode.
  if (!senderId) {
    return authRequired
      ? { ok: false, reason: "AUTH_REQUIRED" }
      : { ok: true };
  }

  // 1v1 match → verify participant membership.
  if (isValidObjectId(matchId)) {
    const match = await MatchModel.findById(matchId)
      .select("players")
      .lean();
    if (!match) return { ok: false, reason: "MATCH_NOT_FOUND" };
    const isParticipant = (match.players || []).some(
      (p) => String(p) === String(senderId)
    );
    return isParticipant
      ? { ok: true }
      : { ok: false, reason: "NOT_PARTICIPANT" };
  }

  // Tournament / custom match id → require authentication (already have it).
  return { ok: true };
}

/**
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 */
export default function registerMatchLiveHandlers(io, socket) {
  // Join a live match room to receive score updates.
  socket.on("match:watch", (payload) => {
    const matchId = matchIdOf(payload);
    if (!matchId) return;
    socket.join(`match:${matchId}`);
    socket.emit("match:watching", { matchId });
  });

  // Leave a live match room.
  socket.on("match:unwatch", (payload) => {
    const matchId = matchIdOf(payload);
    if (!matchId) return;
    socket.leave(`match:${matchId}`);
  });

  // Push a live score update; broadcast to everyone watching the match room
  // (including the sender's own other devices).
  socket.on("match:score", async (payload) => {
    try {
      const matchId = matchIdOf(payload);
      if (!matchId) return;

      const senderId = socket.authUserId ? String(socket.authUserId) : "";
      const verdict = await authorizeScorePush(matchId, senderId);
      if (!verdict.ok) {
        if (verdict.reason && verdict.reason !== "MATCH_NOT_FOUND") {
          socket.emit("match:score:rejected", { matchId, reason: verdict.reason });
        }
        return;
      }

      const update = buildScoreUpdate(payload, senderId, Date.now());
      io.to(`match:${matchId}`).emit("match:score:update", update);
    } catch (error) {
      console.error("match:score error", error?.message || error);
    }
  });
}
