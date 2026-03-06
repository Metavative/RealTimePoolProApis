import StoreItem from "../models/storeItem.model.js";
import StoreOrder from "../models/storeOrder.model.js";

function userIdFromReq(req) {
  return req.user?.id || req.user?._id || null;
}

function isAdmin(req) {
  const role =
    req.user?.role ||
    req.user?.userType ||
    req.user?.profile?.role ||
    req.user?.profile?.userType ||
    "";

  const x = String(role).trim().toLowerCase();
  return x.includes("admin") || x.includes("organizer") || x.includes("club");
}

function normalizeType(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeSku(v) {
  return String(v || "").trim().toUpperCase();
}

// --------------------------------------------------
// PUBLIC / PLAYER
// --------------------------------------------------

export async function listItems(req, res) {
  try {
    const type = normalizeType(req.query.type);
    const q = String(req.query.q || "").trim();

    const filter = { active: true };

    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) {
      filter.type = type;
    }

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { tags: { $in: [new RegExp(q, "i")] } },
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

    const shippingAddress =
      req.body?.shippingAddress && typeof req.body.shippingAddress === "object"
        ? req.body.shippingAddress
        : {};

    const notes = String(req.body?.notes || "").trim();

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
        .json({ ok: false, code: "OUT_OF_STOCK", message: "Item out of stock" });
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
          currency: item.currency,
          imageUrl: item.images?.thumbUrl || item.images?.previewUrl || "",
        },
      ],
      subtotal,
      currency: item.currency || "GBP",
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      shippingAddress: {
        fullName: String(shippingAddress.fullName || "").trim(),
        line1: String(shippingAddress.line1 || "").trim(),
        line2: String(shippingAddress.line2 || "").trim(),
        city: String(shippingAddress.city || "").trim(),
        county: String(shippingAddress.county || "").trim(),
        postcode: String(shippingAddress.postcode || "").trim(),
        country: String(shippingAddress.country || "UK").trim(),
        phone: String(shippingAddress.phone || "").trim(),
      },
      notes,
    });

    return res.json({
      ok: true,
      message: "Order created",
      order,
      stripeReady: false,
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
// ADMIN
// --------------------------------------------------

export async function adminCreateItem(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const body = req.body || {};

    const sku = normalizeSku(body.sku);
    const type = normalizeType(body.type);
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const price = Number(body.price || 0);
    const stockQty = Math.max(0, Number(body.stockQty || 0));
    const rarity = normalizeType(body.rarity || "COMMON");
    const currency = String(body.currency || "GBP").trim().toUpperCase();

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
        thumbUrl: String(body.images?.thumbUrl || "").trim(),
        previewUrl: String(body.images?.previewUrl || "").trim(),
      },
      currency,
      price,
      stockQty,
      rarity,
      tags: Array.isArray(body.tags)
        ? body.tags.map((x) => String(x).trim()).filter(Boolean)
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
    if (body.name != null) patch.name = String(body.name).trim();
    if (body.description != null) patch.description = String(body.description).trim();
    if (body.price != null) patch.price = Number(body.price);
    if (body.stockQty != null) patch.stockQty = Math.max(0, Number(body.stockQty));
    if (body.rarity != null) patch.rarity = normalizeType(body.rarity);
    if (body.currency != null) patch.currency = String(body.currency).trim().toUpperCase();
    if (body.active != null) patch.active = !!body.active;
    if (body.sortOrder != null) patch.sortOrder = Number(body.sortOrder);
    if (body.weightKg != null) patch.weightKg = Number(body.weightKg);

    if (body.images) {
      patch.images = {
        thumbUrl: String(body.images.thumbUrl || "").trim(),
        previewUrl: String(body.images.previewUrl || "").trim(),
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
      patch.tags = body.tags.map((x) => String(x).trim()).filter(Boolean);
    }

    const item = await StoreItem.findOneAndUpdate({ sku }, patch, {
      new: true,
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
      .json({ ok: false, message: e.message || "Failed to delete item" });
  }
}

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

    const orderId = String(req.params.orderId || "").trim();
    const orderStatus = normalizeType(req.body?.orderStatus);
    const paymentStatus = normalizeType(req.body?.paymentStatus);

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