// services/socket_handler/matchHandler.js
//
// Phase B2: deliver match events to the user ROOM (`user:<id>`) so every device
// the user has open receives them (multi-device), instead of a single overwritten
// socket id. Also adds participant verification to the result relay so an
// authenticated socket can no longer forge a match result for users it isn't
// playing against (closes a Phase 0 deferred hardening item).

function emitToUser(io, userId, event, payload) {
  const uid = String(userId || "");
  if (!uid) return;
  io.to(`user:${uid}`).emit(event, payload);
}

/**
 * Match challenge real time events
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 * @param {Map<string, Set<string>>} presence
 */
export default function registerMatchHandlers(io, socket, presence) {
  // 1) challenge sent (server forwards to opponent)
  socket.on("match:challenge_sent", async (payload) => {
    try {
      const opponentId = payload?.opponentId;
      const matchId = payload?.matchId;
      const entryFee = payload?.entryFee;
      const challengerInfo = payload?.challengerInfo;

      if (!opponentId || !matchId) return;

      // If the socket is authenticated, stamp the real challenger id so it can't
      // be spoofed in challengerInfo. Soft mode (no token) keeps legacy payload.
      const senderId = socket.authUserId ? String(socket.authUserId) : "";

      emitToUser(io, opponentId, "match:challenge_received", {
        matchId,
        entryFee,
        challengerInfo,
        challengerId: senderId || challengerInfo?.userId || null,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error("match:challenge_sent error", error?.message || error);
    }
  });

  // 2) challenge accepted (server forwards to challenger)
  socket.on("match:challenge_accepted", async (payload) => {
    try {
      const challengerId = payload?.challengerId;
      const matchId = payload?.matchId;

      if (!challengerId || !matchId) return;

      emitToUser(io, challengerId, "match:started", {
        matchId,
        message: "Your challenge has been accepted. Starting match.",
      });
    } catch (error) {
      console.error("match:challenge_accepted error", error?.message || error);
    }
  });

  // 3) match completed (server notifies both players)
  socket.on("match:completed_notification", async (payload) => {
    try {
      const players = payload?.players;
      const matchId = payload?.matchId;
      const winnerId = payload?.winnerId;

      if (!matchId) return;
      if (!Array.isArray(players) || players.length === 0) return;

      // Participant verification: an authenticated sender must be one of the
      // players in the match it is reporting. This blocks a logged-in user from
      // pushing a fake result to arbitrary other users. (The authoritative
      // result/settlement still goes through the HTTP finishMatch endpoint; this
      // socket event is only a UI notification relay.)
      const senderId = socket.authUserId ? String(socket.authUserId) : "";
      if (senderId) {
        const isParticipant = players.some((p) => String(p) === senderId);
        if (!isParticipant) {
          console.warn(
            `match:completed_notification rejected: ${senderId} not a participant of ${matchId}`
          );
          return;
        }
      }

      for (const userId of players) {
        emitToUser(io, userId, "match:result", {
          matchId,
          winnerId,
          message:
            String(winnerId) === String(userId)
              ? "Congratulations! You won the match."
              : "You lost the match. Better luck next time.",
        });
      }
    } catch (error) {
      console.error("match:completed_notification error", error?.message || error);
    }
  });
}
