// playerService.js
import User from "../models/user.model.js";

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

// Get nearby players
export async function getNearbyPlayers(userId, radiusKm = 5) {
  const user = await User.findById(userId);
  // Zaroori: Location ka GeoJSON coordinates check karein
  if (!user || !user.location?.coordinates) return [];

  const [lng, lat] = user.location.coordinates;

  // Conflict 3 Fix: 'online: true' ki jagah 'profile.onlineStatus: true' use kiya gaya
  const players = await User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true, 
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000 // meters
      }
    }
  }).select("username profile.nickname profile.avatar profile.avatarUrl profile.photo profile.profileImage profile.avatarUpdatedAt stats.totalWinnings profile.verified location");

  return players.map((player) => {
    const row = player.toObject ? player.toObject() : { ...player };
    const avatar = resolveAvatarUrl(row);
    row.profile = { ...(row.profile || {}) };
    if (avatar) {
      row.profile.avatar = avatar;
      row.profile.avatarUrl = avatar;
      row.profile.photo = avatar;
      row.profile.profileImage = avatar;
    } else {
      row.profile.avatarUrl = "";
    }
    return row;
  });
}
