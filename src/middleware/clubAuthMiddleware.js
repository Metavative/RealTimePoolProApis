import Club from "../models/club.model.js";
import { verify } from "../services/jwtService.js";

export async function clubAuthMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const parts = String(header).trim().split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid Authorization format" });
    }

    const token = parts[1];
    const payload = verify(token);

    if (!payload || !payload.id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    // Enforce club-scoped tokens
    const isClub =
      payload.typ === "club_access" ||
      payload.role === "CLUB" ||
      payload.userType === "CLUB" ||
      payload.userType === "club";

    if (!isClub) {
      return res.status(403).json({ message: "Club token required" });
    }

    const club = await Club.findById(payload.id).select({
      passwordHash: 0,
      password: 0,
      otp: 0,
    });

    if (!club) {
      return res.status(401).json({ message: "Club not found" });
    }

    req.clubId = club._id;
    req.club = club;

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
