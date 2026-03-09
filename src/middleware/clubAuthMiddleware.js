// src/middleware/clubAuthMiddleware.js
import Club from "../models/club.model.js";
import User from "../models/user.model.js";
import { verify } from "../services/jwtService.js";

async function ensureClubOwnerUser(club) {
  if (!club) return null;

  if (club.owner) {
    const ownerUser = await User.findById(club.owner).select({
      passwordHash: 0,
      otp: 0,
    });
    if (ownerUser) return ownerUser;
  }

  let matchedUser = null;

  if (club.email) {
    matchedUser = await User.findOne({ email: club.email }).select({
      passwordHash: 0,
      otp: 0,
    });
  }

  if (!matchedUser && club.phone) {
    matchedUser = await User.findOne({ phone: club.phone }).select({
      passwordHash: 0,
      otp: 0,
    });
  }

  if (matchedUser) {
    club.owner = matchedUser._id;
    await club.save();
    return matchedUser;
  }

  return null;
}

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

    const clubId = payload?.id || payload?._id || payload?.clubId;
    if (!clubId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    const isClub =
      payload.typ === "club_access" ||
      payload.role === "CLUB" ||
      payload.userType === "CLUB" ||
      payload.userType === "club";

    if (!isClub) {
      return res.status(403).json({ message: "Club token required" });
    }

    const club = await Club.findById(clubId).select({
      passwordHash: 0,
      password: 0,
      otp: 0,
    });

    if (!club) {
      return res.status(401).json({ message: "Club not found" });
    }

    const ownerUser = await ensureClubOwnerUser(club);

    req.clubId = club._id.toString();
    req.club = club;

    req.authType = "club";
    req.ownerUser = ownerUser || null;
    req.ownerUserId = ownerUser ? ownerUser._id.toString() : null;

    req.auth = {
      tokenRole: "CLUB",
      tokenType: "club_access",
      actorType: ownerUser ? "club_owner_hybrid" : "club_only",
      canManageVenue: true,
      canPlay: !!ownerUser,
    };

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}