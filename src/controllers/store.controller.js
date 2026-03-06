import StoreItem from "../models/storeItem.model.js";
import StoreOrder from "../models/storeOrder.model.js";

function userIdFromReq(req) {
  return req.user?.id || req.user?._id || null;
}

function roleFromReq(req) {
  const candidates = [
    req.user?.role,
    req.user?.userType,
    req.user?.accountType,
    req.user?.profile?.role,
    req.user?.profile?.userType,
    req.user?.profile?.type,
  ];

  for (const c of candidates) {
    const s = String(c || "").trim();
    if (s) return s.toLowerCase();
  }
  return "";
}

function isAdmin(req) {
  const role = roleFromReq(req);
  return (
    role.includes("admin") ||
    role.includes("organizer") ||
    role.includes("club") ||
    role.includes("venue")
  );
}

function normalizeType(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeSku(v) {
  return String(v || "").trim().toUpperCase();
}

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

// --------------------------------------------------
// PLAYER / PUBLIC
// --------------------------------------------------

export async function listItems(req, res) {
  try {
    const type = normalizeType(req.query.type);
    const q = cleanString(req.query.q);

    const filter = { active: true };

    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) {
      filter.type = type;
    }

    if (q) {
      filter.$or = [
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
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load items" });
  }
}

export async function getItem(req, res) {
  try {
    const sku = normalizeSku(req.params.sku);

    if (!sku) {
      return res.status(400).json({ ok: false, message: "Missing sku" });
    }

    const item = await StoreItem.findOne({ sku, active: true }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({ ok: true, item });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load item" });
  }
}

export async function createOrder(req, res) {
  try {
    const userId = userIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const sku = normalizeSku(req.body?.sku);
    const qty = Math.max(1, Number(req.body?.qty || 1));
    const notes = cleanString(req.body?.notes);

    const shippingAddress =
      req.body?.shippingAddress && typeof req.body.shippingAddress === "object"
        ? req.body.shippingAddress
        : {};

    if (!sku) {
      return res.status(400).json({ ok: false, message: "Missing sku" });
    }

    const item = await StoreItem.findOne({ sku, active: true }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    if (item.stockQty <= 0) {
      return res
        .status(400)
        .json({ ok: false, code: "OUT_OF_STOCK", message: "Item is out of stock" });
    }

    if (qty > item.stockQty) {
      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_STOCK",
        message: "Requested quantity exceeds stock",
      });
    }

    const subtotal = Number(item.price || 0) * qty;

    const order = await StoreOrder.create({
      userId,
      items: [
        {
          sku: item.sku,
          type: item.type,
          name: item.name,
          qty,
          unitPrice: item.price,
          currency: item.currency || "GBP",
          imageUrl: item.images?.thumbUrl || item.images?.previewUrl || "",
        },
      ],
      subtotal,
      currency: item.currency || "GBP",
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      shippingAddress: {
        fullName: cleanString(shippingAddress.fullName),
        line1: cleanString(shippingAddress.line1),
        line2: cleanString(shippingAddress.line2),
        city: cleanString(shippingAddress.city),
        county: cleanString(shippingAddress.county),
        postcode: cleanString(shippingAddress.postcode),
        country: cleanString(shippingAddress.country, "UK"),
        phone: cleanString(shippingAddress.phone),
      },
      notes,
    });

    return res.json({
      ok: true,
      message: "Order created",
      stripeReady: false,
      order,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to create order" });
  }
}

export async function myOrders(req, res) {
  try {
    const userId = userIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orders = await StoreOrder.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, orders });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load orders" });
  }
}

// --------------------------------------------------
// ADMIN - PRODUCTS
// --------------------------------------------------

export async function adminCreateItem(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

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
      return res.status(400).json({ ok: false, message: "Invalid product type" });
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
      return res
        .status(409)
        .json({ ok: false, message: "SKU already exists" });
    }

    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to create item" });
  }
}

export async function adminUpdateItem(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const sku = normalizeSku(req.params.sku);

    if (!sku) {
      return res.status(400).json({ ok: false, message: "Missing sku" });
    }

    const body = req.body || {};
    const patch = {};

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
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to update item" });
  }
}

export async function adminDeleteItem(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const sku = normalizeSku(req.params.sku);

    if (!sku) {
      return res.status(400).json({ ok: false, message: "Missing sku" });
    }

    const item = await StoreItem.findOneAndUpdate(
      { sku },
      { active: false },
      { new: true }
    ).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({ ok: true, message: "Item disabled", item });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to disable item" });
  }
}

// --------------------------------------------------
// ADMIN - ORDERS
// --------------------------------------------------

export async function adminListOrders(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const orders = await StoreOrder.find({})
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, orders });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load orders" });
  }
}

export async function adminUpdateOrderStatus(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

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
    }).lean();

    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    return res.json({ ok: true, order });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to update order" });
  }
}