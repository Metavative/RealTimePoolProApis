// services/socket_handler/matchHandler.js

function getSocketIdFromPresence(presence, userId) {
  if (!presence) return null;
  if (!userId) return null;
  return presence.get(String(userId)) || null;
}

/**
 * Match challenge real time events
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 * @param {Map<string,string>} presence
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

      const opponentSocketId = getSocketIdFromPresence(presence, opponentId);
      if (!opponentSocketId) return;

      io.to(opponentSocketId).emit("match:challenge_received", {
        matchId,
        entryFee,
        challengerInfo,
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

      const challengerSocketId = getSocketIdFromPresence(presence, challengerId);
      if (!challengerSocketId) return;

      io.to(challengerSocketId).emit("match:started", {
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

      for (const userId of players) {
        const targetSocketId = getSocketIdFromPresence(presence, userId);
        if (!targetSocketId) continue;

        io.to(targetSocketId).emit("match:result", {
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
