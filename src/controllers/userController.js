// src/controllers/userController.js
import User from "../models/user.model.js";
import { v2 as cloudinary } from "cloudinary";

function buildCapabilities(req) {
  return {
    canPlay: !!req?.auth?.canPlay || !!req?.userId,
    canManageVenue: !!req?.auth?.canManageVenue || !!req?.clubId,
    actorType: req?.auth?.actorType || "user",
    authType: req?.authType || "user",
  };
}

function safeClub(club) {
  if (!club) return null;
  const obj = club.toObject ? club.toObject() : { ...club };
  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;
  return obj;
}

function mergePlainObject(target = {}, patch = {}) {
  const out = { ...(target || {}) };

  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObject(out[key], value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

export async function me(req, res) {
  try {
    let user = req.user;

    if (!user && req.userId) {
      user = await User.findById(req.userId).select("-passwordHash -otp");
    }

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      user,
      club: safeClub(req.club || null),
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateProfile(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const payload = req.body || {};

    // ✅ safer field handling
    if (payload.profile !== undefined) {
      user.profile = mergePlainObject(user.profile || {}, payload.profile || {});
    }

    if (payload.feedbacks !== undefined && Array.isArray(payload.feedbacks)) {
      user.feedbacks = payload.feedbacks;
    }

    if (payload.earnings !== undefined && payload.earnings && typeof payload.earnings === "object") {
      user.earnings = mergePlainObject(user.earnings || {}, payload.earnings || {});
    }

    if (payload.stats !== undefined && payload.stats && typeof payload.stats === "object") {
      user.stats = mergePlainObject(user.stats || {}, payload.stats || {});
    }

    // ✅ optional direct username update support
    if (payload.username !== undefined) {
      user.username = String(payload.username || "").trim() || null;
    }

    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "profile_pics",
            transformation: [{ width: 400, height: 400, crop: "fill", gravity: "auto" }],
          },
          (uploadError, uploadResult) => {
            if (uploadError) reject(uploadError);
            else resolve(uploadResult);
          }
        );

        stream.end(req.file.buffer);
      });

      user.profile = user.profile || {};
      user.profile.avatar = result.secure_url;
    }

    await user.save();

    const safeUser = await User.findById(user._id).select("-passwordHash -otp");

    return res.json({
      user: safeUser,
      club: safeClub(req.club || null),
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    console.log("Error in updateProfile", error.message);
    return res.status(500).json({ message: error.message });
  }
}

export async function nearestPlayers(req, res) {
  try {
    const users = await User.find({
      "profile.onlineStatus": true,
      _id: { $ne: req.userId },
    })
      .select("-passwordHash -otp")
      .limit(50);

    return res.json({
      users,
      capabilities: buildCapabilities(req),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}