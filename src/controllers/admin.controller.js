import User from "../models/user.model.js";
import Club from "../models/club.model.js";
import StoreItem from "../models/storeItem.model.js";
import StoreOrder from "../models/storeOrder.model.js";
import Tournament from "../models/tournament.model.js";

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function normalizeType(v) {
  return cleanString(v).toUpperCase();
}

function normalizeSku(v) {
  return cleanString(v).toUpperCase();
}

function roleFromUser(user) {
  const candidates = [
    user?.role,
    user?.userType,
    user?.accountType,
    user?.profile?.role,
    user?.profile?.userType,
    user?.profile?.type,
  ];

  for (const c of candidates) {
    const s = cleanString(c).toLowerCase();
    if (s) return s;
  }
  return "";
}

function isAdminUser(user) {
  const role = roleFromUser(user);
  return (
    role.includes("admin") ||
    role.includes("organizer") ||
    role.includes("club") ||
    role.includes("venue")
  );
}

// --------------------------------------------------
// ADMIN PROFILE / SESSION
// --------------------------------------------------

export async function me(req, res) {
  try {
    return res.json({
      ok: true,
      admin: {
        id: req.user?._id,
        email: req.user?.email || "",
        username: req.user?.username || "",
        nickname: req.user?.profile?.nickname || "",
        role: roleFromUser(req.user),
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load admin profile",
    });
  }
}

// --------------------------------------------------
// USERS
// --------------------------------------------------

export async function listUsers(req, res) {
  try {
    const q = cleanString(req.query.q);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q) {
      filter.$or = [
        { email: { $regex: q, $options: "i" } },
        { phone: { $regex: q, $options: "i" } },
        { username: { $regex: q, $options: "i" } },
        { usernameLower: { $regex: q.toLowerCase(), $options: "i" } },
        { "profile.nickname": { $regex: q, $options: "i" } },
        { "profile.firstName": { $regex: q, $options: "i" } },
        { "profile.lastName": { $regex: q, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("-passwordHash -otp")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return res.json({
      ok: true,
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load users",
    });
  }
}

export async function getUser(req, res) {
  try {
    const userId = cleanString(req.params.userId);

    const user = await User.findById(userId)
      .select("-passwordHash -otp")
      .lean();

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true, user });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load user",
    });
  }
}

export async function updateUserRole(req, res) {
  try {
    const userId = cleanString(req.params.userId);
    const role = cleanString(req.body?.role);

    if (!userId || !role) {
      return res.status(400).json({
        ok: false,
        message: "userId and role are required",
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          "profile.role": role,
          "profile.userType": role,
        },
      },
      { new: true }
    )
      .select("-passwordHash -otp")
      .lean();

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true, user });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update user role",
    });
  }
}

export async function setUserActive(req, res) {
  try {
    const userId = cleanString(req.params.userId);
    const active = !!req.body?.active;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          "profile.active": active,
        },
      },
      { new: true }
    )
      .select("-passwordHash -otp")
      .lean();

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true, user });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update user status",
    });
  }
}

// --------------------------------------------------
// STORE ITEMS
// --------------------------------------------------

export async function listStoreItems(req, res) {
  try {
    const type = normalizeType(req.query.type);
    const includeInactive = String(req.query.includeInactive || "")
      .trim()
      .toLowerCase() === "true";
    const q = cleanString(req.query.q);

    const filter = {};
    if (!includeInactive) filter.active = true;
    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) filter.type = type;

    if (q) {
      filter.$or = [
        { sku: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { tags: { $elemMatch: { $regex: q, $options: "i" } } },
      ];
    }

    const items = await StoreItem.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load store items",
    });
  }
}

export async function getStoreItem(req, res) {
  try {
    const sku = normalizeSku(req.params.sku);

    const item = await StoreItem.findOne({ sku }).lean();
    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load store item",
    });
  }
}

export async function createStoreItem(req, res) {
  try {
    const body = req.body || {};

    const sku = normalizeSku(body.sku);
    const type = normalizeType(body.type);
    const name = cleanString(body.name);
    const description = cleanString(body.description);
    const currency = cleanString(body.currency || "GBP").toUpperCase();
    const price = Number(body.price || 0);
    const stockQty = Math.max(0, Number(body.stockQty || 0));
    const rarity = normalizeType(body.rarity || "COMMON");

    if (!sku || !type || !name) {
      return res.status(400).json({
        ok: false,
        message: "sku, type and name are required",
      });
    }

    if (!["CUE", "TABLE", "ACCESSORY"].includes(type)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid product type",
      });
    }

    const item = await StoreItem.create({
      sku,
      type,
      name,
      description,
      images: {
        thumbUrl: cleanString(body.images?.thumbUrl),
        previewUrl: cleanString(body.images?.previewUrl),
      },
      currency,
      price,
      stockQty,
      rarity,
      tags: Array.isArray(body.tags)
        ? body.tags.map((x) => cleanString(x)).filter(Boolean)
        : [],
      weightKg: Number(body.weightKg || 0),
      dimensions: {
        lengthCm: Number(body.dimensions?.lengthCm || 0),
        widthCm: Number(body.dimensions?.widthCm || 0),
        heightCm: Number(body.dimensions?.heightCm || 0),
      },
      active: body.active !== false,
      sortOrder: Number(body.sortOrder || 0),
    });

    return res.status(201).json({ ok: true, item });
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "SKU already exists",
      });
    }

    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create item",
    });
  }
}

export async function updateStoreItem(req, res) {
  try {
    const sku = normalizeSku(req.params.sku);
    const body = req.body || {};
    const patch = {};

    if (!sku) {
      return res.status(400).json({ ok: false, message: "Missing sku" });
    }

    if (body.type != null) patch.type = normalizeType(body.type);
    if (body.name != null) patch.name = cleanString(body.name);
    if (body.description != null) patch.description = cleanString(body.description);
    if (body.currency != null) patch.currency = cleanString(body.currency).toUpperCase();
    if (body.price != null) patch.price = Number(body.price);
    if (body.stockQty != null) patch.stockQty = Math.max(0, Number(body.stockQty));
    if (body.rarity != null) patch.rarity = normalizeType(body.rarity);
    if (body.active != null) patch.active = !!body.active;
    if (body.sortOrder != null) patch.sortOrder = Number(body.sortOrder);
    if (body.weightKg != null) patch.weightKg = Number(body.weightKg);

    if (body.images) {
      patch.images = {
        thumbUrl: cleanString(body.images.thumbUrl),
        previewUrl: cleanString(body.images.previewUrl),
      };
    }

    if (body.dimensions) {
      patch.dimensions = {
        lengthCm: Number(body.dimensions.lengthCm || 0),
        widthCm: Number(body.dimensions.widthCm || 0),
        heightCm: Number(body.dimensions.heightCm || 0),
      };
    }

    if (Array.isArray(body.tags)) {
      patch.tags = body.tags.map((x) => cleanString(x)).filter(Boolean);
    }

    const item = await StoreItem.findOneAndUpdate({ sku }, patch, {
      new: true,
      runValidators: true,
    }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update item",
    });
  }
}

export async function disableStoreItem(req, res) {
  try {
    const sku = normalizeSku(req.params.sku);

    const item = await StoreItem.findOneAndUpdate(
      { sku },
      { active: false },
      { new: true }
    ).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({
      ok: true,
      message: "Item disabled",
      item,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to disable item",
    });
  }
}

// --------------------------------------------------
// ORDERS
// --------------------------------------------------

export async function listOrders(req, res) {
  try {
    const orderStatus = normalizeType(req.query.orderStatus);
    const paymentStatus = normalizeType(req.query.paymentStatus);

    const filter = {};
    if (
      ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"].includes(
        orderStatus
      )
    ) {
      filter.orderStatus = orderStatus;
    }
    if (["PENDING", "PAID", "FAILED", "REFUNDED"].includes(paymentStatus)) {
      filter.paymentStatus = paymentStatus;
    }

    const orders = await StoreOrder.find(filter)
      .populate("userId", "email username profile.nickname")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, orders });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load orders",
    });
  }
}

export async function getOrder(req, res) {
  try {
    const orderId = cleanString(req.params.orderId);

    const order = await StoreOrder.findById(orderId)
      .populate("userId", "email username profile.nickname")
      .lean();

    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    return res.json({ ok: true, order });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load order",
    });
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const orderId = cleanString(req.params.orderId);
    const orderStatus = normalizeType(req.body?.orderStatus);
    const paymentStatus = normalizeType(req.body?.paymentStatus);

    if (!orderId) {
      return res.status(400).json({ ok: false, message: "Missing orderId" });
    }

    const patch = {};

    if (
      ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"].includes(
        orderStatus
      )
    ) {
      patch.orderStatus = orderStatus;
    }

    if (["PENDING", "PAID", "FAILED", "REFUNDED"].includes(paymentStatus)) {
      patch.paymentStatus = paymentStatus;
    }

    const order = await StoreOrder.findByIdAndUpdate(orderId, patch, {
      new: true,
      runValidators: true,
    })
      .populate("userId", "email username profile.nickname")
      .lean();

    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    return res.json({ ok: true, order });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update order",
    });
  }
}

// --------------------------------------------------
// TOURNAMENTS
// --------------------------------------------------

export async function listTournaments(req, res) {
  try {
    const status = cleanString(req.query.status).toUpperCase();

    const filter = {};
    if (status) filter.status = status;

    const tournaments = await Tournament.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, tournaments });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load tournaments",
    });
  }
}

export async function getTournament(req, res) {
  try {
    const tournamentId = cleanString(req.params.tournamentId);

    const tournament = await Tournament.findById(tournamentId).lean();
    if (!tournament) {
      return res.status(404).json({ ok: false, message: "Tournament not found" });
    }

    return res.json({ ok: true, tournament });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load tournament",
    });
  }
}

export async function updateTournamentStatus(req, res) {
  try {
    const tournamentId = cleanString(req.params.tournamentId);
    const status = cleanString(req.body?.status).toUpperCase();

    const allowed = ["DRAFT", "ACTIVE", "LIVE", "COMPLETED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid tournament status",
      });
    }

    const tournament = await Tournament.findByIdAndUpdate(
      tournamentId,
      { status },
      { new: true, runValidators: true }
    ).lean();

    if (!tournament) {
      return res.status(404).json({ ok: false, message: "Tournament not found" });
    }

    return res.json({ ok: true, tournament });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update tournament",
    });
  }
}

// --------------------------------------------------
// STATS / DASHBOARD
// --------------------------------------------------

export async function dashboardStats(req, res) {
  try {
    const [usersCount, storeItemsCount, ordersCount, tournamentsCount, paidAgg] =
      await Promise.all([
        User.countDocuments({}),
        StoreItem.countDocuments({}),
        StoreOrder.countDocuments({}),
        Tournament.countDocuments({}),
        StoreOrder.aggregate([
          { $match: { paymentStatus: "PAID" } },
          {
            $group: {
              _id: null,
              revenue: { $sum: "$subtotal" },
            },
          },
        ]),
      ]);

    return res.json({
      ok: true,
      stats: {
        usersCount,
        storeItemsCount,
        ordersCount,
        tournamentsCount,
        revenue: paidAgg?.[0]?.revenue || 0,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load dashboard stats",
    });
  }
}

// --------------------------------------------------
// CLUBS / ORGANIZER VERIFICATION
// --------------------------------------------------

export async function listClubs(req, res) {
  try {
    const status = cleanString(req.query.status).toUpperCase();
    const q = cleanString(req.query.q);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const skip = (page - 1) * limit;

    const filter = {};
    if (status) filter.status = status;

    if (q) {
      filter.$or = [
        { email: { $regex: q, $options: "i" } },
        { phone: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { "verification.venueName": { $regex: q, $options: "i" } },
      ];
    }

    const [clubs, total] = await Promise.all([
      Club.find(filter)
        .populate("owner", "email username profile.nickname")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Club.countDocuments(filter),
    ]);

    return res.json({
      ok: true,
      clubs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to load clubs",
    });
  }
}

export async function updateClubStatus(req, res) {
  try {
    const clubId = cleanString(req.params.clubId);
    const status = cleanString(req.body?.status).toUpperCase();
    const verified =
      req.body?.verified === undefined ? undefined : !!req.body.verified;

    const allowed = ["ACTIVE", "PENDING_VERIFICATION", "PENDING_REVIEW", "SUSPENDED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid club status",
      });
    }

    const patch = { status };
    if (verified !== undefined) patch.verified = verified;

    const club = await Club.findByIdAndUpdate(clubId, patch, {
      new: true,
      runValidators: true,
    })
      .populate("owner", "email username profile.nickname")
      .lean();

    if (!club) {
      return res.status(404).json({ ok: false, message: "Club not found" });
    }

    return res.json({ ok: true, club });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to update club status",
    });
  }
}
