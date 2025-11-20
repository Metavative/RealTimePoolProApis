import User from "../../models/user.model.js";

/**
 * Zaroori Utility: GeoJSON $near query se qareebi online players ko nikalta hai.
 */
async function getNearbyPlayers(userId, radiusKm = 5) {
  const user = await User.findById(userId);
  // Agar user ka location data nahi hai, to ruk jayen.
  if (!user || !user.location?.coordinates) return []; 

  const [lng, lat] = user.location.coordinates;

  return User.find({
    _id: { $ne: userId },
    // Conflict 3 Fix: Query ko 'profile.onlineStatus' se theek kiya gaya
    "profile.onlineStatus": true, 
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000, // meters
      },
    },
  }).select("profile.nickname profile.avatar stats.totalWinnings profile.verified location");
}

/**
 * Socket.IO logic for live presence (status, location, nearby players)
 */
export default function registerPresenceHandlers(io, socket, presence) {
  
  // Event: Client ki taraf se userId aur location bhej kar identification shuru hoti hai.
  // Yeh 'player:online' aur 'identify' ka mel hai.
  socket.on("user:identify", async ({ userId, location }) => {
    if (!userId) return;

    // 1. DB Update (Status aur Location dono GeoJSON format mein)
    const updateData = {
      "profile.onlineStatus": true,
      lastSeen: new Date(),
    };
    if (location && location.lng && location.lat) {
      // Conflict 1 Fix: Location hamesha GeoJSON Point ki tarah save hogi.
      updateData.location = { type: "Point", coordinates: [location.lng, location.lat] };
    }
    await User.findByIdAndUpdate(userId, updateData);

    // 2. Presence Map Update (index.js se shift kiya gaya)
    socket.userId = userId;
    presence.set(userId, socket.id);

    // 3. Emit global update
    io.emit("presence:update", {
      userId,
      status: "online",
      onlineUsers: Array.from(presence.keys()),
    });
    console.log(`🟢 User ${userId} is now online and identified`);

    // 4. Nearby Players logic (Agar location update hui hai to)
    if (location && location.lng && location.lat) {
      const nearbyPlayers = await getNearbyPlayers(userId);
      socket.emit("nearbyPlayers", nearbyPlayers);
      
      // Notify others nearby
      for (const player of nearbyPlayers) {
        // io.to() se dusre players ko notify karein
        const targetSocketId = presence.get(player._id.toString());
        if(targetSocketId) {
             io.to(targetSocketId).emit("playerNearby", {
              userId,
              nickname: user.profile.nickname, // Agar yahan pura user object mil jaaye to behtar hai
              location,
            });
        }
      }
    }
  });

  // Event: Sirf location update karna (previously 'player:move' and 'updateLocation')
  socket.on("user:move", async ({ userId, location }) => {
    if (!userId || !location || !location.lng || !location.lat) return;
    
    // Conflict 1 Fix: GeoJSON Point update
    await User.findByIdAndUpdate(userId, {
      location: { type: "Point", coordinates: [location.lng, location.lat] },
      lastSeen: new Date(),
    });

    // Nearby player list ko client ko wapas bhejo
    const nearbyPlayers = await getNearbyPlayers(userId);
    socket.emit("nearbyPlayers", nearbyPlayers);
  });

  // Conflict 2 Fix: Sirf index.js ka disconnect handler use hoga, baaki files se hata diya gaya.
}
