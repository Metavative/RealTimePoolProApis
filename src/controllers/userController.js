 import User from "../models/user.model.js"
 import { v2 as cloudinary } from "cloudinary"
 
 export async function me(req, res) {
    try {
        const user = await User.findById(req.userId).select("-passwordHash");
        res.json({ user })
    } catch (error) {
        return res.status(500).json({
            message: error.message
        })
    }
 }

 export async function updateProfile(req, res) {
    try {
        const user = await User.findById(req.userId);

        if( !user ) return res.status(404).json({ message: "User not found" });

        //Allow Fields 
        const payload = req.body;
        const allowed = ["profile", "feedbacks", "earnings", "stats"];

        // Update normal fields
        for (const k of allowed) {
            if (payload[k] !== undefined ) user[k] = payload[k];
        }

        // Check if file uploaded
if (req.file) {
  // Wrap in Promise since upload_stream uses callback
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "profile_pics", // ✅ fixed spelling
        transformation: [
{ width: 400, height: 400, crop: "fill", gravity: "auto" }
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    stream.end(req.file.buffer); // ✅ pipe multer file buffer into stream
  });

  // ✅ Save avatar URL to user profile
  user.profile.avatar = result.secure_url;
  await user.save();

        } else {
            await user.save();
        }
            res.json({ user });

    } catch (error) {
        console.log("Error in update Profile ", error.message);
        res.status(500).json({ message: err.message });

    }
 }

 
 export async function nearestPlayers( req,res ) {
    try {
        // naive: expects query lng, lat and radius in km
        const { lng, lat, km = 10 } = req.query;
        const club = await ( await import("../models/club.model.js")).default; 

        const users = await User.find({ "profile.onlineStatus": true }).limit(50);

        // For full gerolocation of user store coordinates; here return online users list
        res.json({ users });

    } catch (error) {
        res.status(500).json({ message: error.message })
    }
 }