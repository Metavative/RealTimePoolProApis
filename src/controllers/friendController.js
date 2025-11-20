import FriendRequest from "../models/friend.model.js";
import User from "../models/user.model.js";

/**
 * ==========================
 * SEND FRIEND REQUEST
 * ==========================
 */
export async function sendRequest(req, res, io, presence) {
  try {
    const from = req.userId;
    const { to } = req.body;
    console.log("📤 Sending request:", { from, to });

    if (!to) {
      console.log("❌ No recipient provided");
      return res.status(400).json({ message: "Recipient (to) is required" });
    }
    if (from === to) {
      console.log("❌ Tried to send to self");
      return res.status(400).json({ message: "You cannot send a request to yourself" });
    }

    const sender = await User.findById(from);
    if (sender?.friends?.includes(to)) {
      console.log("❌ Already friends");
      return res.status(400).json({ message: "Already friends" });
    }

    const exists = await FriendRequest.findOne({ from, to, status: "pending" });
    if (exists) {
      console.log("❌ Request already pending");
      return res.status(400).json({ message: "Friend request already pending" });
    }

    const fr = await FriendRequest.create({ from, to });
    console.log("✅ Friend request created:", fr._id);

    const toSocket = presence.get(to?.toString());
    if (toSocket) io.to(toSocket).emit("friend:request:new", { from, request: fr });

    res.json({ success: true, fr });
  } catch (error) {
    console.error("❌ sendRequest error:", error);
    res.status(500).json({ message: error.message });
  }
}


/**
 * ==========================
 * RESPOND TO FRIEND REQUEST
 * ==========================
 */
export async function respond(req, res, io, presence) {
  try {
    const { requestId, accept } = req.body;
    const fr = await FriendRequest.findById(requestId);
    if (!fr) return res.status(404).json({ message: "Request not found" });

    // Update request status
    fr.status = accept ? "accepted" : "rejected";
    await fr.save();

    // If accepted, add to both users' friend lists
    if (accept) {
      await User.findByIdAndUpdate(fr.from, { $addToSet: { friends: fr.to } });
      await User.findByIdAndUpdate(fr.to, { $addToSet: { friends: fr.from } });
    }

    // ⚡ Real-time sync: notify both users
    const fromSocket = presence.get(fr.from?.toString());
    const toSocket = presence.get(fr.to?.toString());

    if (fromSocket) io.to(fromSocket).emit("friend:request:updated", fr);
    if (toSocket) io.to(toSocket).emit("friend:request:updated", fr);

    res.json({ success: true, fr });
  } catch (err) {
    console.error("❌ respond error:", err);
    res.status(500).json({ message: err.message });
  }
 
}

/**
 * ==========================
 * SEARCH FRIENDS
 * ==========================
 */
// export async function searchFriends(req, res) {
//   try {
//     const userId = req.userId;
//     const { query } = req.query; // nickname or userIdTag

//     // Get current user's friends
//     const currentUser = await User.findById(userId).populate(
//       "friends",
//       "profile.nickname profile.avatar stats.userIdTag profile.onlineStatus"
//     );

//     const friendIds = currentUser?.friends?.map((f) => f._id.toString()) || [];

//     // Build search filter
//     const searchFilter = query
//       ? {
//           $or: [
//             { "profile.nickname": { $regex: query, $options: "i" } },
//             { "stats.userIdTag": { $regex: query, $options: "i" } },
//           ],
//         }
//       : {};

//     // Find matching users
//     const users = await User.find(searchFilter)
//       .select("profile.nickname profile.avatar stats.userIdTag profile.onlineStatus")
//       .lean();

//     // Mark relation status
//     const result = users.map((u) => {
//       let relation = "none";
//       if (friendIds.includes(u._id.toString())) relation = "friend";
//       return { ...u, relation };
//     });

//     res.json({ success: true, data: result });
//   } catch (error) {
//     console.error("❌ searchFriends error:", error);
//     res.status(500).json({ message: error.message });
//   }
// }

export async function searchFriends(req, res) {
  try {
    const userId = req.userId;
    const { query } = req.query;

    // Get current user's friends
    const currentUser = await User.findById(userId).populate(
      "friends",
      "profile.nickname profile.avatar stats.userIdTag profile.onlineStatus"
    );

    const friendIds = currentUser?.friends?.map((f) => f._id.toString()) || [];

    // Build search filter
    const searchFilter = query
      ? {
          $or: [
            { "profile.nickname": { $regex: query, $options: "i" } },
            { "stats.userIdTag": { $regex: query, $options: "i" } },
          ],
        }
      : {};

    // Find matching users
    const users = await User.find(searchFilter)
      .select("profile.nickname profile.avatar stats.userIdTag profile.onlineStatus")
      .lean();

    // Find all pending requests involving this user
    const requests = await FriendRequest.find({
      $or: [{ from: userId }, { to: userId }],
      status: "pending",
    }).lean();

    // Build response
    const result = users.map((u) => {
      const uid = u._id.toString();
      let status = "none";
      let requestId = null;

      if (friendIds.includes(uid)) {
        status = "friend";
      } else {
        const sentByMe = requests.find(
          (r) => r.from.toString() === userId && r.to.toString() === uid
        );
        const sentToMe = requests.find(
          (r) => r.to.toString() === userId && r.from.toString() === uid
        );

        if (sentByMe) {
          status = "pending"; // ✅ I sent request
          requestId = sentByMe._id;
        } else if (sentToMe) {
          status = "incoming"; // ✅ They sent me request
          requestId = sentToMe._id;
        }
      }

      return {
        _id: uid,
        nickname: u?.profile?.nickname || "Unknown User",
        avatar: u?.profile?.avatar || "",
        userIdTag: u?.stats?.userIdTag || "",
        onlineStatus: u?.profile?.onlineStatus || false,
        status,
        requestId,
      };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("❌ searchFriends error:", error);
    res.status(500).json({ message: error.message });
  }
}
