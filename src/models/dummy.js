import FriendRequest from "../models/friend.model.js";
import User from "../models/user.model.js";

// ------------------ SEND REQUEST ------------------
export async function sendRequest(req, res) {
  try {
    const from = req.userId;
    const { to } = req.body;

    if (!to) return res.status(400).json({ message: "to required" });

    if (from === to) return res.status(400).json({ message: "Cannot add yourself" });

    const existing = await FriendRequest.findOne({
      $or: [
        { from, to },
        { from: to, to: from },
      ],
      status: { $in: ["pending", "accepted"] },
    });

    if (existing) {
      return res.status(400).json({ message: "Request already exists or accepted" });
    }

    const fr = await FriendRequest.create({ from, to });
    res.json({ success: true, friendRequest: fr });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ------------------ RESPOND TO REQUEST ------------------
export async function respond(req, res) {
  try {
    const { requestId, accept } = req.body;
    const fr = await FriendRequest.findById(requestId);
    if (!fr) return res.status(404).json({ message: "Request not found" });

    fr.status = accept ? "accepted" : "rejected";
    await fr.save();

    if (accept) {
      await User.findByIdAndUpdate(fr.from, { $addToSet: { friends: fr.to } });
      await User.findByIdAndUpdate(fr.to, { $addToSet: { friends: fr.from } });
    }

    res.json({ success: true, updated: fr });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ------------------ SEARCH FRIENDS ------------------
export async function searchFriends(req, res) {
  try {
    const userId = req.userId;
    const { query } = req.query; // nickname or userIdTag

    // Step 1: find all accepted friends
    const currentUser = await User.findById(userId).populate("friends", "profile.nickname profile.avatar stats.userIdTag profile.onlineStatus");
    const friendIds = currentUser.friends.map((f) => f._id.toString());

    // Step 2: build search filter
    const searchFilter = query
      ? {
          $or: [
            { "profile.nickname": { $regex: query, $options: "i" } },
            { "stats.userIdTag": { $regex: query, $options: "i" } },
          ],
        }
      : {};

    // Step 3: search users
    const users = await User.find(searchFilter)
      .select("profile.nickname profile.avatar stats.userIdTag profile.onlineStatus")
      .lean();

    // Step 4: attach status
    const result = users.map((u) => {
      let relation = "none";
      if (friendIds.includes(u._id.toString())) relation = "friend";
      return { ...u, relation };
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}
