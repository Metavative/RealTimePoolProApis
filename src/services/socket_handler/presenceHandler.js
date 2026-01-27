import User from "../../models/user.model.js";

const DASH = String.fromCharCode(45);

async function getOnlineUsersFromPresence(presence) {
  const ids = Array.from(presence.keys());
  if (ids.isEmpty) return [];

  const users = await User.find({ _id: { $in: ids } })
    .select(
      "profile.nickname profile.avatar profile.onlineStatus profile.verified stats.userIdTag stats.rank stats.totalWinnings"
    )
    .lean();

  const map = new Map(users.map((u) => [String(u._id), u]));
  return ids.map((id) => map.get(String(id))).filter(Boolean);
}

async function getNearbyPlayersByCoords(userId, lng, lat, radiusKm = 5) {
  if (lng === null || lng === undefined || lat === null || lat === undefined) {
    return [];
  }

  return User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .select(
      "profile.nickname profile.avatar profile.onlineStatus profile.verified stats.userIdTag stats.rank stats.totalWinnings location"
    )
    .lean();
}

function pickLngLat(location) {
  if (!location) return { lng: null, lat: null };

  const lng = location.lng ?? location.longitude ?? null;
  const lat = location.lat ?? location.latitude ?? null;

  if (typeof lng !== "number" || typeof lat !== "number") {
    return { lng: null, lat: null };
  }
  return { lng, lat };
}

export default function registerPresenceHandlers(io, socket, presence) {
  async function identifyUser(userId, location) {
    if (!userId) return;

    const { lng, lat } = pickLngLat(location);

    const updateData = {
      "profile.onlineStatus": true,
      lastSeen: new Date(),
    };

    if (lng !== null && lat !== null) {
      updateData.location = { type: "Point", coordinates: [lng, lat] };
      updateData["profile.longitude"] = lng;
      updateData["profile.latitude"] = lat;
    }

    await User.findByIdAndUpdate(userId, updateData);

    socket.userId = String(userId);
    presence.set(String(userId), socket.id);

    const onlineUsers = await getOnlineUsersFromPresence(presence);
    io.emit("presence:update", onlineUsers);

    if (lng !== null && lat !== null) {
      const nearbyPlayers = await getNearbyPlayersByCoords(String(userId), lng, lat);
      socket.emit("nearbyPlayers", nearbyPlayers);
    }
  }

  async function moveUser(userId, location) {
    if (!userId) return;

    const { lng, lat } = pickLngLat(location);
    if (lng === null || lat === null) return;

    await User.findByIdAndUpdate(String(userId), {
      location: { type: "Point", coordinates: [lng, lat] },
      "profile.longitude": lng,
      "profile.latitude": lat,
      lastSeen: new Date(),
    });

    const nearbyPlayers = await getNearbyPlayersByCoords(String(userId), lng, lat);
    socket.emit("nearbyPlayers", nearbyPlayers);
  }

  socket.on("user:identify", async (payload) => {
    try {
      await identifyUser(payload?.userId, payload?.location);
    } catch (e) {
      console.log("user:identify error", e);
    }
  });

  socket.on("identify", async (payload) => {
    try {
      await identifyUser(payload?.userId, payload?.location);
    } catch (e) {
      console.log("identify error", e);
    }
  });

  socket.on("player:online", async (payload) => {
    try {
      await identifyUser(payload?.userId, payload?.location);
    } catch (e) {
      console.log("player:online error", e);
    }
  });

  socket.on("userOnline", async (payload) => {
    try {
      const id = typeof payload === "string" ? payload : payload?.userId;
      await identifyUser(id, payload?.location);
    } catch (e) {
      console.log("userOnline error", e);
    }
  });

  socket.on("user:move", async (payload) => {
    try {
      await moveUser(payload?.userId, payload?.location);
    } catch (e) {
      console.log("user:move error", e);
    }
  });

  socket.on("updateLocation", async (payload) => {
    try {
      const loc = { lng: payload?.lng, lat: payload?.lat };
      await moveUser(payload?.userId, loc);
    } catch (e) {
      console.log("updateLocation error", e);
    }
  });

  socket.on("player:move", async (payload) => {
    try {
      await moveUser(payload?.userId, payload?.location);
    } catch (e) {
      console.log("player:move error", e);
    }
  });

  socket.on("disconnect", async () => {
    try {
      if (!socket.userId) return;

      presence.delete(String(socket.userId));

      await User.findByIdAndUpdate(String(socket.userId), {
        "profile.onlineStatus": false,
        lastSeen: new Date(),
      });

      const onlineUsers = await getOnlineUsersFromPresence(presence);
      io.emit("presence:update", onlineUsers);
    } catch (e) {
      console.log("disconnect presence error", e);
    }
  });
}
