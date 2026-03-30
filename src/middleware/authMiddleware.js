// src/middleware/authMiddleware.js
import User from "../models/user.model.js";
import Club from "../models/club.model.js";
import { verify } from "../services/jwtService.js";

async function ensureClubOwnerUser(club) {
  if (!club) return null;

  const normalizeVenueOwnerProfile = async (user) => {
    if (!user) return null;

    let changed = false;
    user.profile = user.profile || {};

    if (String(user.profile.role || "").toUpperCase() !== "VENUE_OWNER") {
      user.profile.role = "VENUE_OWNER";
      changed = true;
    }
    if (String(user.profile.userType || "").toUpperCase() !== "VENUE_OWNER") {
      user.profile.userType = "VENUE_OWNER";
      changed = true;
    }

    const organizer = user.profile.organizer || {};
    const nextOrganizer = {
      ...organizer,
      clubId: club._id,
      clubName: club.name || "",
    };

    if (
      String(organizer.clubId || "") !== String(nextOrganizer.clubId || "") ||
      String(organizer.clubName || "") !== String(nextOrganizer.clubName || "")
    ) {
      user.profile.organizer = nextOrganizer;
      changed = true;
    }

    if (changed) {
      await user.save();
    }
    return user;
  };

  if (club.owner) {
    const ownerUser = await User.findById(club.owner).select({ passwordHash: 0, otp: 0 });
    if (ownerUser) return normalizeVenueOwnerProfile(ownerUser);
  }

  let matchedUser = null;

  if (club.email) {
    matchedUser = await User.findOne({ email: club.email }).select({ passwordHash: 0, otp: 0 });
  }

  if (!matchedUser && club.phone) {
    matchedUser = await User.findOne({ phone: club.phone }).select({ passwordHash: 0, otp: 0 });
  }

  if (matchedUser) {
    club.owner = matchedUser._id;
    await club.save();
    return normalizeVenueOwnerProfile(matchedUser);
  }

  return null;
}

export async function authMiddleware(req, res, next) {
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

    const tokenRole = String(payload.role || "").toUpperCase();
    const tokenType = String(payload.typ || "").toLowerCase();

    // =========================================
    // CLUB TOKEN -> MAP TO LINKED OWNER USER
    // =========================================
    if (tokenRole === "CLUB" || tokenType === "club_access") {
      const club = await Club.findById(payload.id).select({ passwordHash: 0, otp: 0 });
      if (!club) {
        return res.status(401).json({ message: "Club not found" });
      }

      const ownerUser = await ensureClubOwnerUser(club);
      if (!ownerUser) {
        return res.status(403).json({
          message: "Club is not linked to a player profile yet",
        });
      }

      req.authType = "user"; // ✅ compatibility for older user-only controllers
      req.auth = {
        tokenRole: "CLUB",
        tokenType: "club_access",
        actorType: "club_owner_as_player",
        canManageVenue: true,
        canPlay: true,
      };

      req.club = club;
      req.clubId = club._id.toString();

      req.user = ownerUser;
      req.userId = ownerUser._id.toString();

      return next();
    }

    // =========================================
    // NORMAL USER TOKEN
    // =========================================
    const user = await User.findById(payload.id).select({ passwordHash: 0, otp: 0 });
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.authType = "user";
    req.auth = {
      tokenRole: "USER",
      tokenType: tokenType || "access",
      actorType: "user",
      canManageVenue: false,
      canPlay: true,
    };

    req.userId = user._id.toString();
    req.user = user;

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
