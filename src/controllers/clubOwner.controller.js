import mongoose from "mongoose";
import Club from "../models/club.model.js";
import User from "../models/user.model.js";

function requireClub(req, res) {
  if (req.authType !== "club" || !req.clubId || !req.club) {
    res.status(403).json({ message: "Club authorization required" });
    return false;
  }
  return true;
}

/**
 * POST /api/club/owner/bind
 * club-only
 * body: { ownerUserId } OR { ownerUsername } OR { ownerEmail }
 *
 * - Allows binding owner ONLY if Club.owner is currently empty
 */
export async function bindClubOwner(req, res) {
  try {
    if (!requireClub(req, res)) return;

    const clubId = String(req.clubId || "");
    if (!clubId) return res.status(400).json({ message: "clubId missing" });

    const club = await Club.findById(clubId);
    if (!club) return res.status(404).json({ message: "Club not found" });

    if (club.owner) {
      return res.status(200).json({
        message: "Club owner already set",
        data: { clubId: club._id, owner: club.owner },
      });
    }

    const ownerUserId = String(req.body.ownerUserId || "").trim();
    const ownerUsername = String(req.body.ownerUsername || "").trim();
    const ownerEmail = String(req.body.ownerEmail || "").trim().toLowerCase();

    let user = null;

    if (ownerUserId) {
      if (!mongoose.Types.ObjectId.isValid(ownerUserId)) {
        return res.status(400).json({ message: "Invalid ownerUserId" });
      }
      user = await User.findById(ownerUserId);
    } else if (ownerUsername) {
      // matches either username or usernameLower if you have it
      user = await User.findOne({
        $or: [
          { username: new RegExp(`^${ownerUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
          { usernameLower: ownerUsername.toLowerCase() },
        ],
      });
    } else if (ownerEmail) {
      user = await User.findOne({ email: ownerEmail });
    } else {
      return res.status(400).json({
        message: "Provide one of: ownerUserId | ownerUsername | ownerEmail",
      });
    }

    if (!user) return res.status(404).json({ message: "Owner user not found" });

    club.owner = user._id;
    await club.save();

    return res.status(200).json({
      message: "Club owner bound",
      data: { clubId: club._id, owner: club.owner, ownerUsername: user.username },
    });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Failed to bind owner" });
  }
}
