import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Club from "../models/club.model.js";

export async function authAny(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const id = decoded.id || decoded._id || decoded.userId;
    if (!id) return res.status(401).json({ message: "Invalid token" });

    // Reset
    req.user = null;
    req.club = null;
    req.userId = null;
    req.clubId = null;
    req.authType = null;

    if (decoded.typ === "club_access" || decoded.role === "CLUB") {
      const club = await Club.findById(id);
      if (!club) return res.status(401).json({ message: "Club not found" });

      req.club = club;
      req.clubId = club._id.toString();
      req.authType = "club";

      return next();
    }

    const user = await User.findById(id);
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = user;
    req.userId = user._id.toString();
    req.authType = "user";

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
