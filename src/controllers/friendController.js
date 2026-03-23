// src/controllers/friendController.js
import mongoose from "mongoose";
import User from "../models/user.model.js";
import FriendRequest from "../models/friendRequest.model.js";
import Friendship from "../models/friendship.model.js";

// ---------- helpers ----------
function toObjectId(id) {
  return typeof id === "string" ? new mongoose.Types.ObjectId(id) : id;
}

function sortPair(a, b) {
  const as = String(a);
  const bs = String(b);
  return as < bs ? [a, b] : [b, a];
}

function emitToUser(io, presence, userId, event, payload) {
  const room = `user:${userId}`;

  if (io) io.to(room).emit(event, payload);

  if (presence?.getSocketIds) {
    const sockets = presence.getSocketIds(String(userId)) || [];
    for (const sid of sockets) io.to(sid).emit(event, payload);
  }
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isAvatarUrlLike(v) {
  const s = toStr(v);
  if (!s) return false;
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("/") ||
    s.startsWith("uploads/") ||
    s.startsWith("data:image/")
  );
}

function bestName(u) {
  return u?.username || u?.profile?.nickname || "";
}

function bestAvatar(u) {
  const p = u?.profile || {};
  const candidates = [p.avatarUrl, p.photo, p.profileImage, p.avatar];
  for (const c of candidates) {
    const s = toStr(c);
    if (s && isAvatarUrlLike(s)) return s;
  }
  return "";
}

function bestAvatarUpdatedAt(u) {
  return toStr(u?.profile?.avatarUpdatedAt);
}

// ---------- searchFriends ----------
export async function searchFriends(req, res) {
  try {
    const q = String(
      req.query.q ??
        req.query.search ??
        req.query.keyword ??
        req.query.query ??
        ""
    ).trim();

    if (!q) return res.json([]);

    const me = req.userId ? new mongoose.Types.ObjectId(req.userId) : null;
    const regex = new RegExp(q, "i");

    const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(limitRaw, 50))
      : 25;

    const query = {
      $or: [
        { username: regex },
        { usernameLower: regex },
        { "profile.nickname": regex },
        { email: regex },
        { phone: regex },
        { "stats.userIdTag": regex },
      ],
    };

    if (me) query._id = { $ne: me };

    const users = await User.find(query)
      .select(
        [
          "_id",
          "username",
          "usernameLower",
          "email",
          "phone",
          "profile.nickname",
          "profile.avatar",
          "profile.avatarUrl",
          "profile.photo",
          "profile.profileImage",
          "profile.avatarUpdatedAt",
          "profile.onlineStatus",
          "stats.rank",
          "stats.userIdTag",
        ].join(" ")
      )
      .limit(limit)
      .lean();

    return res.json(
      users.map((u) => ({
        id: String(u._id),
        name: bestName(u),
        username: u.username || "",
        email: u.email || "",
        phone: u.phone || "",
        avatarUrl: bestAvatar(u),
        avatarUpdatedAt: bestAvatarUpdatedAt(u),
        online: !!u.profile?.onlineStatus,
        rank: u.stats?.rank || "Beginner",
        tag: u.stats?.userIdTag || "",
      }))
    );
  } catch (err) {
    console.error("searchFriends error:", err);
    return res.status(500).json({ message: "Failed to search users" });
  }
}

// ---------- listRequests ----------
export async function listRequests(req, res) {
  try {
    const me = toObjectId(req.userId);
    const type = String(req.query.type || "incoming").toLowerCase();

    const query =
      type === "outgoing"
        ? { from: me, status: "pending" }
        : { to: me, status: "pending" };

    const requests = await FriendRequest.find(query)
      .sort({ createdAt: -1 })
      .populate(
        "from",
        "_id username profile.nickname profile.avatar profile.avatarUrl profile.photo profile.profileImage profile.avatarUpdatedAt profile.onlineStatus stats.rank stats.userIdTag"
      )
      .populate(
        "to",
        "_id username profile.nickname profile.avatar profile.avatarUrl profile.photo profile.profileImage profile.avatarUpdatedAt profile.onlineStatus stats.rank stats.userIdTag"
      )
      .lean();

    return res.json(
      requests.map((r) => {
        const from = r.from && typeof r.from === "object" ? r.from : null;
        const to = r.to && typeof r.to === "object" ? r.to : null;

        return {
          requestId: r._id,
          status: r.status,
          createdAt: r.createdAt,
          from: from
            ? {
                id: from._id,
                username: from.username || "",
                nickname: bestName(from),
                avatar: bestAvatar(from),
                avatarUpdatedAt: bestAvatarUpdatedAt(from),
                online: !!from.profile?.onlineStatus,
                rank: from.stats?.rank || "Beginner",
                tag: from.stats?.userIdTag || "",
              }
            : { id: r.from },
          to: to
            ? {
                id: to._id,
                username: to.username || "",
                nickname: bestName(to),
                avatar: bestAvatar(to),
                avatarUpdatedAt: bestAvatarUpdatedAt(to),
                online: !!to.profile?.onlineStatus,
                rank: to.stats?.rank || "Beginner",
                tag: to.stats?.userIdTag || "",
              }
            : { id: r.to },
        };
      })
    );
  } catch (err) {
    console.error("listRequests error:", err);
    return res.status(500).json({ message: "Failed to load friend requests" });
  }
}

// ---------- listFriends ----------
export async function listFriends(req, res, presence) {
  try {
    const me = toObjectId(req.userId);

    const rows = await Friendship.find({
      $or: [{ a: me }, { b: me }],
    })
      .sort({ updatedAt: -1 })
      .lean();

    const friendIds = rows.map((f) => (String(f.a) === String(me) ? f.b : f.a));

    const friends = await User.find({ _id: { $in: friendIds } })
      .select(
        "_id username profile.nickname profile.avatar profile.avatarUrl profile.photo profile.profileImage profile.avatarUpdatedAt profile.onlineStatus stats.rank stats.userIdTag"
      )
      .lean();

    const byId = new Map(friends.map((u) => [String(u._id), u]));

    return res.json(
      friendIds
        .map((id) => byId.get(String(id)))
        .filter(Boolean)
        .map((u) => ({
          id: u._id,
          username: u.username || "",
          nickname: bestName(u),
          avatar: bestAvatar(u),
          avatarUpdatedAt: bestAvatarUpdatedAt(u),
          online: presence?.isOnline
            ? !!presence.isOnline(String(u._id))
            : !!u.profile?.onlineStatus,
          rank: u.stats?.rank || "Beginner",
          tag: u.stats?.userIdTag || "",
        }))
    );
  } catch (err) {
    console.error("listFriends error:", err);
    return res.status(500).json({ message: "Failed to load friends" });
  }
}

// ---------- sendRequest ----------
export async function sendRequest(req, res, io, presence) {
  try {
    const me = toObjectId(req.userId);
    const toUserIdRaw = req.body?.toUserId;

    if (!toUserIdRaw) {
      return res.status(400).json({ message: "toUserId is required" });
    }

    const toUserId = toObjectId(toUserIdRaw);

    if (String(me) === String(toUserId)) {
      return res.status(400).json({ message: "You cannot add yourself" });
    }

    const target = await User.findById(toUserId).select("_id").lean();
    if (!target) return res.status(404).json({ message: "User not found" });

    const [a, b] = sortPair(me, toUserId);
    const existingFriend = await Friendship.findOne({ a, b }).lean();
    if (existingFriend) {
      return res.status(409).json({ message: "Already friends" });
    }

    const pendingEitherWay = await FriendRequest.findOne({
      status: "pending",
      $or: [
        { from: me, to: toUserId },
        { from: toUserId, to: me },
      ],
    }).lean();

    if (pendingEitherWay) {
      return res.status(409).json({ message: "Friend request already pending" });
    }

    const request = await FriendRequest.create({
      from: me,
      to: toUserId,
      status: "pending",
    });

    emitToUser(io, presence, toUserId, "friend:request_received", {
      requestId: request._id,
      fromUserId: me,
      toUserId,
      status: request.status,
      createdAt: request.createdAt,
    });

    emitToUser(io, presence, me, "friend:request_sent", {
      requestId: request._id,
      fromUserId: me,
      toUserId,
      status: request.status,
      createdAt: request.createdAt,
    });

    return res.json({
      ok: true,
      requestId: request._id,
      status: request.status,
      createdAt: request.createdAt,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "Friend request already pending" });
    }
    console.error("sendRequest error:", err);
    return res.status(500).json({ message: "Failed to send friend request" });
  }
}

// ---------- respond ----------
export async function respond(req, res, io, presence) {
  try {
    const me = toObjectId(req.userId);
    const requestId = req.body?.requestId;
    const accept = !!req.body?.accept;

    if (!requestId) {
      return res.status(400).json({ message: "requestId is required" });
    }

    const fr = await FriendRequest.findById(requestId).lean();
    if (!fr) return res.status(404).json({ message: "Request not found" });

    if (String(fr.to) !== String(me)) {
      return res.status(403).json({ message: "Not allowed" });
    }

    if (fr.status !== "pending") {
      return res.json({ ok: true, status: fr.status });
    }

    const nextStatus = accept ? "accepted" : "rejected";

    const upd = await FriendRequest.updateOne(
      { _id: fr._id, status: "pending" },
      { $set: { status: nextStatus } }
    );

    if (upd.matchedCount === 0) {
      const latest = await FriendRequest.findById(fr._id).select("status").lean();
      return res.json({ ok: true, status: latest?.status || fr.status });
    }

    if (!accept) {
      emitToUser(io, presence, fr.from, "friend:request_rejected", {
        requestId: fr._id,
        fromUserId: fr.from,
        toUserId: fr.to,
      });

      emitToUser(io, presence, fr.to, "friend:request_rejected", {
        requestId: fr._id,
        fromUserId: fr.from,
        toUserId: fr.to,
      });

      return res.json({ ok: true, status: "rejected" });
    }

    const [a, b] = sortPair(fr.from, fr.to);
    await Friendship.updateOne(
      { a, b },
      { $setOnInsert: { a, b } },
      { upsert: true }
    );

    await FriendRequest.updateMany(
      {
        status: "pending",
        $or: [
          { from: fr.to, to: fr.from },
          { from: fr.from, to: fr.to },
        ],
        _id: { $ne: fr._id },
      },
      { $set: { status: "rejected" } }
    );

    emitToUser(io, presence, fr.from, "friend:request_accepted", {
      requestId: fr._id,
      fromUserId: fr.from,
      toUserId: fr.to,
    });

    emitToUser(io, presence, fr.to, "friend:request_accepted", {
      requestId: fr._id,
      fromUserId: fr.from,
      toUserId: fr.to,
    });

    emitToUser(io, presence, fr.from, "friend:list_updated", {});
    emitToUser(io, presence, fr.to, "friend:list_updated", {});

    return res.json({ ok: true, status: "accepted" });
  } catch (err) {
    console.error("respond error:", err);
    return res.status(500).json({ message: "Failed to respond to request" });
  }
}
