import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Club from "../models/club.model.js";

export async function authAny(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // typ can be: "access" or "club_access"
    const id = decoded.id || decoded._id || decoded.userId;
    if (!id) return res.status(401).json({ message: "Invalid token" });

    if (decoded.typ === "club_access" || decoded.role === "CLUB") {
      const club = await Club.findById(id);
      if (!club) return res.status(401).json({ message: "Club not found" });
      req.club = club;
      req.authType = "club";
      req.userId = club._id.toString(); // optional convenience
      return next();
    }

    const user = await User.findById(id);
    if (!user) return res.status(401).json({ message: "User not found" });
    req.user = user;
    req.authType = "user";
    req.userId = user._id.toString();
    return next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
