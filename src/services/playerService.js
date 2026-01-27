// playerService.js
import User from "../models/user.model.js";

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
  }).select("profile.nickname profile.avatar stats.totalWinnings profile.verified location"); // Fields 'username, profilePhoto, totalWins, coins' ko behtar fields se badla gaya

  return players;
}