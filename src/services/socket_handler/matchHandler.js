// src/socketHandlers/matchHandler.js
// import  getSocketId  from "../redisPresence.js"; // Aapke redisPresence.js se zaroori function

import { getSocketId } from "../redisPresence..js";

// import { getSocketId } from "../redisPresence.js";

/**
 * Match Challenge ke Real-Time events ko handle karta hai.
 * @param {SocketIO.Server} io
 * @param {SocketIO.Socket} socket
 */
export default function registerMatchHandlers(io, socket) {
  
  // ==================================
  // 1. CHALLENGE SENT (Server-to-Opponent)
  // Yeh event HTTP POST /match/challenge se call nahi hoga. 
  // Yeh event client khud chalayega. Jab /match/challenge API hit ho, 
  // uske response mein client yeh event chalaega.
  socket.on("match:challenge_sent", async ({ opponentId, matchId, entryFee, challengerInfo }) => {
    try {
      if (!opponentId) return;

      // Opponent ka socket ID Redis se dhoondo
      const opponentSocketId = await getSocketId(opponentId);

      if (opponentSocketId) {
        console.log(`Sending challenge to ${opponentId} at socket ${opponentSocketId}`);
        
        // Opponent ko 'challenge:received' event bhejo
        io.to(opponentSocketId).emit("match:challenge_received", {
          matchId,
          entryFee,
          challenger: challengerInfo, // nickname, avatar, level jaisi info
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error("Error in match:challenge_sent:", error.message);
    }
  });

  // ==================================
  // 2. CHALLENGE ACCEPTED (Server-to-Challenger)
  // Yeh event /match/accept API call ke response ke baad client chalaega.
  socket.on("match:challenge_accepted", async ({ challengerId, matchId }) => {
    try {
      if (!challengerId) return;
      
      const challengerSocketId = await getSocketId(challengerId);

      if (challengerSocketId) {
        // Challenger ko 'match:started' event bhejo
        io.to(challengerSocketId).emit("match:started", {
          matchId,
          message: "Your challenge has been accepted. Starting match...",
        });
      }
    } catch (error) {
      console.error("Error in match:challenge_accepted:", error.message);
    }
  });
  
  // ==================================
  // 3. MATCH RESULT NOTIFICATION
  // Yeh event /match/finish API call ke response ke baad client chalaega.
  socket.on("match:completed_notification", async ({ players, matchId, winnerId }) => {
    // Dono players ko result bhejo
    for (const userId of players) {
      const targetSocketId = await getSocketId(userId);
      if (targetSocketId) {
        io.to(targetSocketId).emit("match:result", {
          matchId,
          winnerId,
          message: winnerId === userId ? "Congratulations! You won the match." : "You lost the match. Better luck next time.",
        });
      }
    }
  });
}