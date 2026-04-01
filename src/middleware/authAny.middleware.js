import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Club from "../models/club.model.js";

async function findOwnerUserForClub(club) {
  if (!club) return null;

  if (club.owner) {
    const owner = await User.findById(club.owner).select({ passwordHash: 0, otp: 0 });
    if (owner) return owner;
  }

  let matched = null;
  if (club.email) {
    matched = await User.findOne({ email: String(club.email).trim().toLowerCase() }).select({
      passwordHash: 0,
      otp: 0,
    });
  }
  if (!matched && club.phone) {
    matched = await User.findOne({ phone: String(club.phone).trim() }).select({
      passwordHash: 0,
      otp: 0,
    });
  }

  if (matched) {
    club.owner = matched._id;
    await club.save();
    return matched;
  }

  return null;
}

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
    req.auth = null;

    // CLUB token
    if (decoded.typ === "club_access" || decoded.role === "CLUB") {
      // Select owner explicitly (safe if you later add projections)
      const club = await Club.findById(id).select(
        "owner email phone name status verified capabilities"
      );
      if (!club) return res.status(401).json({ message: "Club not found" });

      const ownerUser = await findOwnerUserForClub(club);

      req.club = club;
      req.clubId = club._id.toString();
      req.authType = "club";
      req.auth = {
        tokenRole: "CLUB",
        tokenType: "club_access",
        actorType: ownerUser ? "club_owner_as_player" : "club",
        canManageVenue: true,
        canPlay: !!ownerUser,
      };

      if (ownerUser) {
        req.user = ownerUser;
        req.userId = ownerUser._id.toString();
      }

      return next();
    }

    // USER token
    const user = await User.findById(id).select({ passwordHash: 0, otp: 0 });
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = user;
    req.userId = user._id.toString();
    req.authType = "user";
    req.auth = {
      tokenRole: "USER",
      tokenType: String(decoded.typ || "access").toLowerCase(),
      actorType: "user",
      canManageVenue: false,
      canPlay: true,
    };

    return next();
  } catch (e) {
    return res.status(401).json({
      message: "Unauthorized",
      error: e?.message ? String(e.message) : undefined,
    });
  }
}
