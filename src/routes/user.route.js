import express from "express"
import { authMiddleware } from "../middleware/authMiddleware.js"
import * as useCtrl from "../controllers/userController.js"
import userUpload from "../lib/user.multer.js";

const router = express.Router();

router.get("/me", authMiddleware,useCtrl.me );
router.patch("/me", authMiddleware ,userUpload.single("userAvatar"), useCtrl.updateProfile)
router.get("/nearest", authMiddleware, useCtrl.nearestPlayers);
router.get("/nearest/:id", async (req, res) => {
  const userId = req.params.id;
  const currentUser = await User.findById(userId);
  if (!currentUser) return res.status(404).json({ message: "User not found" });

  const { latitude, longitude } = currentUser.profile;
  if (!latitude || !longitude)
    return res.status(400).json({ message: "Location not set" });

  const allUsers = await User.find({ "profile.onlineStatus": true });

  const distance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // km
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
    .filter((u) => u._id.toString() !== userId)
    .map((u) => ({
      id: u._id,
      nickname: u.profile.nickname,
      avatar: u.profile.avatar,
      distance: distance(latitude, longitude, u.profile.latitude, u.profile.longitude),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);

  res.json(nearby);
});
export default router;