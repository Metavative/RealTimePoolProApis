// src/routes/user.routes.js
import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as useCtrl from "../controllers/userController.js";
import userUpload from "../lib/user.multer.js";
import User from "../models/user.model.js";

const router = express.Router();

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

function resolveAvatarUrl(profile = {}) {
  const candidates = [
    profile.avatarUrl,
    profile.photo,
    profile.profileImage,
    profile.avatar,
  ];
  for (const candidate of candidates) {
    const value = toStr(candidate);
    if (value && isAvatarUrlLike(value)) return value;
  }
  return "";
}

router.get("/me", authMiddleware, useCtrl.me);
router.get("/leaderboard", authMiddleware, useCtrl.leaderboard);
router.get("/feedback", authMiddleware, useCtrl.listFeedback);
router.post("/feedback", authMiddleware, useCtrl.createFeedback);
router.get("/earnings", authMiddleware, useCtrl.getEarnings);

router.patch(
  "/me",
  authMiddleware,
  userUpload.single("userAvatar"),
  useCtrl.updateProfile
);

router.get("/nearest", authMiddleware, useCtrl.nearestPlayers);

router.get("/nearest/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;

    const currentUser = await User.findById(userId);
    if (!currentUser) return res.status(404).json({ message: "User not found" });

    const { latitude, longitude } = currentUser.profile || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: "Location not set" });
    }

    const allUsers = await User.find({
      "profile.onlineStatus": true,
      _id: { $ne: userId },
    });

    const distance = (lat1, lon1, lat2, lon2) => {
      const R = 6371;

      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;

      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2;

      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const nearby = allUsers
      .map((u) => ({
        id: u._id,
        username: u.username || "",
        nickname: u.profile?.nickname || "",
        avatar: resolveAvatarUrl(u.profile || {}),
        avatarUrl: resolveAvatarUrl(u.profile || {}),
        avatarUpdatedAt: toStr(u.profile?.avatarUpdatedAt),
        distance: distance(
          latitude,
          longitude,
          u.profile?.latitude,
          u.profile?.longitude
        ),
      }))
      .filter((u) => Number.isFinite(u.distance))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    return res.json({
      users: nearby,
      capabilities: {
        canPlay: !!req?.auth?.canPlay || !!req?.userId,
        canManageVenue: !!req?.auth?.canManageVenue || !!req?.clubId,
        actorType: req?.auth?.actorType || "user",
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

export default router;
