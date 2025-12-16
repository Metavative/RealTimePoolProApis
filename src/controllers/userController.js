import User from "../models/user.model.js";
import { v2 as cloudinary } from "cloudinary";

export async function me(req, res) {
  try {
    if (req.user) {
      return res.json({ user: req.user });
    }

    const user = await User.findById(req.userId).select("-passwordHash -otp");
    return res.json({ user });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateProfile(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const payload = req.body;
    const allowed = ["profile", "feedbacks", "earnings", "stats"];

    for (const k of allowed) {
      if (payload[k] !== undefined) user[k] = payload[k];
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
    return res.json({ user: safeUser });
  } catch (error) {
    console.log("Error in updateProfile", error.message);
    return res.status(500).json({ message: error.message });
  }
}

export async function nearestPlayers(req, res) {
  try {
    const users = await User.find({ "profile.onlineStatus": true })
      .select("-passwordHash -otp")
      .limit(50);

    return res.json({ users });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
