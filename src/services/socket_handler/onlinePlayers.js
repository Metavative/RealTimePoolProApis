// socketHandlers/onlinePlayers.js
import User from "../../models/user.model.js";

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isAvatarUrlLike(v) {
  const s = toStr(v);
  if (!s) return false;
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("/") ||
    s.startsWith("uploads/") ||
    s.startsWith("data:image/")
  );
}

function resolveAvatarUrl(u = {}) {
  const p = u?.profile || {};
  const candidates = [p.avatarUrl, p.photo, p.profileImage, p.avatar];
  for (const candidate of candidates) {
    const s = toStr(candidate);
    if (s && isAvatarUrlLike(s)) return s;
  }
  return "";
}

function normalizeRealtimeUser(u = {}) {
  const avatar = resolveAvatarUrl(u);
  const profile = { ...(u.profile || {}) };
  if (avatar) {
    profile.avatar = avatar;
    profile.avatarUrl = avatar;
    profile.photo = avatar;
    profile.profileImage = avatar;
  } else {
    profile.avatarUrl = "";
  }
  return {
    ...u,
    profile,
  };
}

/**
 * Calculate nearest online players using GeoJSON query
 */
async function getNearbyPlayers(userId, radiusKm = 5) {
  const user = await User.findById(userId);
  if (!user || !user.location?.coordinates) return [];

  const [lng, lat] = user.location.coordinates;

  return User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000, // meters
      },
    },
  })
    .select("username profile.nickname profile.avatar profile.avatarUrl profile.photo profile.profileImage profile.avatarUpdatedAt stats.totalWinnings profile.verified location")
    .lean()
    .then((rows) => rows.map((row) => normalizeRealtimeUser(row)));
}

/**
 * Register Socket.IO logic for live online + nearby player syncing
 */
export default function registerOnlinePlayerHandlers(io, socket) {
  // Player connects
  socket.on("player:online", async ({ userId, location }) => {
    if (!userId || !location) return;

    // Update DB
    await User.findByIdAndUpdate(userId, {
      "profile.onlineStatus": true,
      location: { type: "Point", coordinates: [location.lng, location.lat] },
      lastSeen: new Date(),
    });

    socket.userId = userId;

    // Emit nearby players
    const nearbyPlayers = await getNearbyPlayers(userId);
    socket.emit("nearbyPlayers", nearbyPlayers);

    // Notify others nearby
    for (const player of nearbyPlayers) {
      io.to(player._id.toString()).emit("playerNearby", {
        userId,
        nickname: player.profile.nickname,
        avatar: resolveAvatarUrl(player),
        avatarUrl: resolveAvatarUrl(player),
        avatarUpdatedAt: toStr(player?.profile?.avatarUpdatedAt),
        location,
      });
    }
  });

  // Player moves (live update)
  socket.on("player:move", async ({ userId, location }) => {
    if (!userId || !location) return;

    await User.findByIdAndUpdate(userId, {
      location: { type: "Point", coordinates: [location.lng, location.lat] },
      lastSeen: new Date(),
    });

    const nearbyPlayers = await getNearbyPlayers(userId);
    socket.emit("nearbyPlayers", nearbyPlayers);
  });

  // Player disconnects
  socket.on("disconnect", async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, {
        "profile.onlineStatus": false,
        lastSeen: new Date(),
      });
      io.emit("playerOffline", socket.userId);
    }
  });
}
