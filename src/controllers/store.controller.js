import StoreItem from "../models/storeItem.model.js";
import StoreOrder from "../models/storeOrder.model.js";
import PaymentIntent from "../models/paymentIntent.model.js";
import { v2 as cloudinary } from "cloudinary";
import { resolvePaymentProvider } from "../services/payments/paymentProvider.factory.js";

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
  if (req?.auth?.canManageVenue === true) return true;
  if (req?.clubId || req?.club?._id) return true;

  const actorType = String(req?.auth?.actorType || "").toLowerCase();
  const tokenRole = String(req?.auth?.tokenRole || "").toLowerCase();
  if (actorType.includes("club") || tokenRole === "club") return true;

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

function upper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function storeCheckoutV2Enabled() {
  return boolFromEnv("FEATURE_STORE_CHECKOUT_V2", false);
}

function paymentsV2Enabled() {
  return boolFromEnv("FEATURE_PAYMENTS_V2", false);
}

function paymentProviderName() {
  return upper(process.env.PAYMENTS_PROVIDER, "MOCK");
}

function paymentProviderEnv() {
  const env = upper(process.env.PAYMENTS_ENVIRONMENT, "SANDBOX");
  return env === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

function checkoutReservationMinutes() {
  const minutes = Number(process.env.STORE_CHECKOUT_RESERVATION_MINUTES || 20);
  if (!Number.isFinite(minutes)) return 20;
  return Math.max(5, Math.min(120, Math.floor(minutes)));
}

function nowPlusMinutes(minutes) {
  return new Date(Date.now() + Math.max(0, minutes) * 60 * 1000);
}

function toMinorUnits(amountMajor) {
  const value = Number(amountMajor || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(Math.round(value * 100));
}

function generatePublicId(prefix) {
  const seed = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${upper(prefix)}_${Date.now()}_${seed}`;
}

function normalizeSku(v) {
  return String(v || "").trim().toUpperCase();
}

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function looksLikeOpaqueId(v) {
  const s = cleanString(v);
  if (!s) return false;
  if (/^[a-fA-F0-9]{24}$/.test(s)) return true;
  if (/^[A-Za-z0-9_-]{36,}$/.test(s)) return true;
  return false;
}

function emailLocalPart(email) {
  const value = cleanString(email).toLowerCase();
  if (!value || !value.includes("@")) return "";
  const local = value.split("@")[0].trim();
  if (!local || looksLikeOpaqueId(local)) return "";
  return local;
}

function profileFrom(user) {
  if (!user || typeof user !== "object") return {};
  const profile = user.profile;
  if (profile && typeof profile === "object") return profile;
  return {};
}

function displayBuyerNameFromSources({ buyer, order }) {
  const user = buyer && typeof buyer === "object" ? buyer : {};
  const profile = profileFrom(user);
  const snapshot =
    order && typeof order.buyerSnapshot === "object" ? order.buyerSnapshot : {};
  const shipping =
    order && typeof order.shippingAddress === "object" ? order.shippingAddress : {};

  const fullNameFromParts = cleanString(
    `${cleanString(snapshot.firstName)} ${cleanString(snapshot.lastName)}`
  );
  const profileFullName = cleanString(
    `${cleanString(profile.firstName)} ${cleanString(profile.lastName)}`
  );

  const candidates = [
    snapshot.username,
    user.username,
    snapshot.nickname,
    profile.nickname,
    order?.buyerUsername,
    order?.username,
    snapshot.name,
    profile.name,
    fullNameFromParts,
    profileFullName,
    shipping.fullName,
    emailLocalPart(snapshot.email),
    emailLocalPart(user.email),
  ];

  for (const candidate of candidates) {
    const value = cleanString(candidate);
    if (!value) continue;
    if (looksLikeOpaqueId(value)) continue;
    return value;
  }

  return "Buyer";
}

function normalizeVisibility(v) {
  const x = String(v || "").trim().toUpperCase();
  if (x === "PRIVATE") return "PRIVATE";
  return "GLOBAL";
}

function globalVisibilityFilter() {
  return [
    { visibility: "GLOBAL" },
    { visibility: "global" }, // legacy
    { visibility: "" }, // legacy
    { visibility: null }, // legacy
    { visibility: { $exists: false } }, // legacy
  ];
}

function publicActiveFilter() {
  return [
    { active: true },
    { active: { $exists: false } }, // legacy
  ];
}

function dateToMs(value) {
  if (!value) return 0;
  const dt = value instanceof Date ? value : new Date(value);
  const ms = dt.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function normalizedStockQty(raw) {
  const value = Number(raw || 0);
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : Math.floor(value);
}

function orderStatusFromIntentStatus(intentStatus) {
  const s = upper(intentStatus, "PENDING_PAYMENT");
  if (s === "PAID") {
    return {
      paymentStatus: "PAID",
      orderStatus: "PROCESSING",
      reservationStatus: "CONSUMED",
    };
  }
  if (["FAILED", "CANCELLED", "EXPIRED"].includes(s)) {
    return {
      paymentStatus: "FAILED",
      orderStatus: "CANCELLED",
      reservationStatus: "RELEASED",
    };
  }
  return {
    paymentStatus: "PENDING",
    orderStatus: "PENDING",
    reservationStatus: "RESERVED",
  };
}

function publicItemQuery(sku) {
  return {
    $and: [
      { sku },
      { $or: publicActiveFilter() },
      { $or: globalVisibilityFilter() },
    ],
  };
}

async function restoreStockForOrderItems(items = []) {
  const operations = [];
  for (const row of items) {
    const sku = normalizeSku(row?.sku);
    const qty = Math.max(0, Number(row?.qty || 0));
    if (!sku || qty <= 0) continue;
    operations.push({
      updateOne: {
        filter: { sku },
        update: { $inc: { stockQty: qty } },
      },
    });
  }
  if (operations.length === 0) return;
  await StoreItem.bulkWrite(operations, { ordered: false });
}

async function releaseReservedStockIfNeeded(order) {
  if (!order || upper(order.reservationStatus) !== "RESERVED") {
    return { released: false, order };
  }

  const updated = await StoreOrder.findOneAndUpdate(
    {
      _id: order._id,
      reservationStatus: "RESERVED",
    },
    {
      reservationStatus: "RELEASED",
      paymentUpdatedAt: new Date(),
    },
    { new: true }
  ).lean();

  if (!updated) {
    const latest = await StoreOrder.findById(order._id).lean();
    return { released: false, order: latest || order };
  }

  await restoreStockForOrderItems(updated.items || []);
  return { released: true, order: updated };
}

function buildBuyerSnapshot(req) {
  const profile =
    req.user?.profile && typeof req.user.profile === "object" ? req.user.profile : {};
  return {
    username: cleanString(req.user?.username),
    nickname: cleanString(profile.nickname),
    name: cleanString(profile.name),
    firstName: cleanString(profile.firstName),
    lastName: cleanString(profile.lastName),
    email: cleanString(req.user?.email).toLowerCase(),
  };
}

function buildShippingAddress(raw) {
  const shippingAddress = raw && typeof raw === "object" ? raw : {};
  return {
    fullName: cleanString(shippingAddress.fullName),
    line1: cleanString(shippingAddress.line1),
    line2: cleanString(shippingAddress.line2),
    city: cleanString(shippingAddress.city),
    county: cleanString(shippingAddress.county),
    postcode: cleanString(shippingAddress.postcode),
    country: cleanString(shippingAddress.country, "UK"),
    phone: cleanString(shippingAddress.phone),
  };
}

function paymentIntentSummary(intent) {
  if (!intent) return null;
  return {
    intentId: cleanString(intent.intentId),
    status: upper(intent.status),
    provider: upper(intent.provider),
    environment: upper(intent.environment),
    checkoutUrl: cleanString(intent.checkoutUrl),
    clientToken: cleanString(intent.clientToken),
    amountMinor: Number(intent.amountMinor || 0),
    currency: upper(intent.currency || "GBP"),
    expiresAt: intent.expiresAt || null,
  };
}

function withInventoryState(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return rawItem;

  const stockQty = normalizedStockQty(rawItem.stockQty);
  const inventoryVersionMs = dateToMs(rawItem.updatedAt || rawItem.createdAt);
  return {
    ...rawItem,
    stockQty,
    soldOut: stockQty <= 0,
    inStock: stockQty > 0,
    inventoryVersionMs,
  };
}

async function latestCatalogVersionMs(filter = {}) {
  const latest = await StoreItem.findOne(filter)
    .sort({ updatedAt: -1, createdAt: -1 })
    .select({ updatedAt: 1, createdAt: 1 })
    .lean();

  if (!latest) return 0;
  return dateToMs(latest.updatedAt || latest.createdAt);
}

async function uploadStoreImageToCloudinary({ file, ownerRef }) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new Error("Image file is required");
  }

  const folder = `store_items/${cleanString(ownerRef, "unknown") || "unknown"}`;
  const safeName =
    cleanString(file.originalname).replace(/\.[^.]+$/, "") || `store_item_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "image",
        folder,
        use_filename: true,
        unique_filename: true,
        filename_override: safeName,
        overwrite: false,
        transformation: [{ width: 1280, height: 1280, crop: "limit" }],
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );

    stream.end(file.buffer);
  });
}

// --------------------------------------------------
// PLAYER / PUBLIC
// --------------------------------------------------

export async function listItems(req, res) {
  try {
    const type = normalizeType(req.query.type);
    const q = cleanString(req.query.q);

    const andFilter = [
      { $or: publicActiveFilter() },
      { $or: globalVisibilityFilter() },
    ];

    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) {
      andFilter.push({ type });
    }

    if (q) {
      andFilter.push({
        $or: [
          { name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
          { tags: { $elemMatch: { $regex: q, $options: "i" } } },
        ],
      });
    }

    const filter = { $and: andFilter };

    const items = await StoreItem.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    const normalized = items.map((item) => withInventoryState(item));
    const catalogVersionMs = await latestCatalogVersionMs(filter);

    return res.json({
      ok: true,
      items: normalized,
      meta: {
        count: normalized.length,
        catalogVersionMs,
        serverTimeMs: Date.now(),
      },
    });
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

    const item = await StoreItem.findOne({
      $and: [
        { sku },
        { $or: publicActiveFilter() },
        { $or: globalVisibilityFilter() },
      ],
    }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }
    const normalized = withInventoryState(item);
    return res.json({
      ok: true,
      item: normalized,
      meta: {
        inventoryVersionMs: normalized?.inventoryVersionMs || 0,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load item" });
  }
}

async function createOrderWithPaymentLifecycle(req, res, userId) {
  const sku = normalizeSku(req.body?.sku);
  const qty = Math.max(1, Number(req.body?.qty || 1));
  const notes = cleanString(req.body?.notes);
  const shippingAddress = buildShippingAddress(req.body?.shippingAddress);
  const successUrl = cleanString(req.body?.successUrl);
  const cancelUrl = cleanString(req.body?.cancelUrl);
  const failureUrl = cleanString(req.body?.failureUrl);

  if (!sku) {
    return res.status(400).json({ ok: false, message: "Missing sku" });
  }

  const reserveQuery = {
    ...publicItemQuery(sku),
    stockQty: { $gte: qty },
  };

  const reservedItem = await StoreItem.findOneAndUpdate(
    reserveQuery,
    { $inc: { stockQty: -qty } },
    { new: true }
  ).lean();

  if (!reservedItem) {
    const latest = await StoreItem.findOne(publicItemQuery(sku)).lean();
    if (!latest) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }
    if (Number(latest.stockQty || 0) <= 0) {
      return res.status(400).json({
        ok: false,
        code: "OUT_OF_STOCK",
        message: "Item is out of stock",
      });
    }
    return res.status(400).json({
      ok: false,
      code: "INSUFFICIENT_STOCK",
      message: "Requested quantity exceeds stock",
    });
  }

  const subtotal = Number(reservedItem.price || 0) * qty;
  const amountMinor = toMinorUnits(subtotal);
  if (amountMinor <= 0) {
    await StoreItem.updateOne({ _id: reservedItem._id }, { $inc: { stockQty: qty } }).catch(
      () => {}
    );
    return res.status(400).json({
      ok: false,
      message: "Invalid order amount",
    });
  }

  const reservationExpiresAt = nowPlusMinutes(checkoutReservationMinutes());
  let order = null;
  let intent = null;

  try {
    order = await StoreOrder.create({
      userId,
      buyerSnapshot: buildBuyerSnapshot(req),
      items: [
        {
          sku: reservedItem.sku,
          type: reservedItem.type,
          name: reservedItem.name,
          qty,
          unitPrice: reservedItem.price,
          currency: reservedItem.currency || "GBP",
          imageUrl:
            reservedItem.images?.thumbUrl || reservedItem.images?.previewUrl || "",
        },
      ],
      subtotal,
      currency: reservedItem.currency || "GBP",
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      paymentFlowVersion: "V2",
      reservationStatus: "RESERVED",
      reservationExpiresAt,
      reservedStockQty: qty,
      paymentUpdatedAt: new Date(),
      shippingAddress,
      notes,
    });

    const idempotencyKey = cleanString(
      req.headers["x-idempotency-key"] || req.body?.idempotencyKey || `SHOP_${order._id}`
    );

    intent = await PaymentIntent.create({
      intentId: generatePublicId("PAY"),
      module: "SHOP",
      moduleRefId: String(order._id),
      userId,
      clubId: null,
      provider: paymentProviderName(),
      environment: paymentProviderEnv(),
      currency: reservedItem.currency || "GBP",
      amountMinor,
      status: "CREATED",
      checkoutUrl: "",
      clientToken: "",
      idempotencyKey,
      expiresAt: reservationExpiresAt,
      statusTimeline: [
        {
          status: "CREATED",
          at: new Date(),
          note: "Shop checkout intent created",
          actor: "store_api",
        },
      ],
      metadata: {
        shopOrderId: String(order._id),
        sku: reservedItem.sku,
        qty,
      },
    });

    const provider = resolvePaymentProvider(intent.provider || paymentProviderName());
    const session = await provider.createCheckoutSession({
      intent,
      successUrl,
      cancelUrl,
      failureUrl,
    });

    if (cleanString(session?.providerPaymentId)) {
      intent.providerPaymentId = cleanString(session.providerPaymentId);
    }
    if (cleanString(session?.providerReference)) {
      intent.providerReference = cleanString(session.providerReference);
    }
    if (cleanString(session?.checkoutUrl)) {
      intent.checkoutUrl = cleanString(session.checkoutUrl);
    }
    if (cleanString(session?.clientToken)) {
      intent.clientToken = cleanString(session.clientToken);
    }
    if (session?.expiresAt) {
      intent.expiresAt = new Date(session.expiresAt);
    }
    const sessionStatus = upper(session?.status || "PENDING_PAYMENT");
    intent.status = sessionStatus;
    intent.statusTimeline = [
      ...(Array.isArray(intent.statusTimeline) ? intent.statusTimeline : []),
      {
        status: sessionStatus,
        at: new Date(),
        note: "Checkout session ready for shop order",
        actor: "provider",
      },
    ];
    await intent.save();

    const mapped = orderStatusFromIntentStatus(sessionStatus);
    order = await StoreOrder.findByIdAndUpdate(
      order._id,
      {
        paymentIntentId: intent._id,
        paymentIntentRef: intent.intentId,
        paymentStatus: mapped.paymentStatus,
        orderStatus: mapped.orderStatus,
        reservationStatus: mapped.reservationStatus,
        paymentUpdatedAt: new Date(),
      },
      { new: true }
    ).lean();

    return res.status(201).json({
      ok: true,
      message: "Checkout created",
      paymentFlowVersion: "V2",
      order,
      paymentIntent: paymentIntentSummary(intent),
      item: withInventoryState({
        sku: reservedItem.sku,
        stockQty: Number(reservedItem.stockQty || 0),
        updatedAt: reservedItem.updatedAt || new Date(),
      }),
      meta: {
        orderId: String(order?._id || ""),
        sku: reservedItem.sku,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    if (intent?._id) {
      await PaymentIntent.deleteOne({ _id: intent._id }).catch(() => {});
    }
    if (order?._id) {
      await StoreOrder.deleteOne({ _id: order._id }).catch(() => {});
    }
    await StoreItem.updateOne({ _id: reservedItem._id }, { $inc: { stockQty: qty } }).catch(
      () => {}
    );

    const providerNotConfigured =
      upper(e?.code || "") === "MYPOS_NOT_CONFIGURED" ||
      upper(e?.code || "").includes("NOT_IMPLEMENTED");
    if (providerNotConfigured) {
      return res.status(503).json({
        ok: false,
        message: "Payment provider is not configured for shop checkout yet.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create checkout",
    });
  }
}

export async function createOrder(req, res) {
  try {
    const userId = userIdFromReq(req);

    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    if (storeCheckoutV2Enabled() && paymentsV2Enabled()) {
      return createOrderWithPaymentLifecycle(req, res, userId);
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

    const item = await StoreItem.findOne({
      $and: [
        { sku },
        { $or: publicActiveFilter() },
        { $or: globalVisibilityFilter() },
      ],
    }).lean();

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

    // Reserve stock atomically to avoid overselling when orders arrive together.
    const reservedItem = await StoreItem.findOneAndUpdate(
      {
        $and: [
          { sku },
          { $or: publicActiveFilter() },
          { $or: globalVisibilityFilter() },
          { stockQty: { $gte: qty } },
        ],
      },
      { $inc: { stockQty: -qty } },
      { new: true }
    ).lean();

    if (!reservedItem) {
      const latest = await StoreItem.findOne({
        $and: [
          { sku },
          { $or: publicActiveFilter() },
          { $or: globalVisibilityFilter() },
        ],
      }).lean();

      if (!latest) {
        return res.status(404).json({ ok: false, message: "Item not found" });
      }
      if (Number(latest.stockQty || 0) <= 0) {
        return res.status(400).json({
          ok: false,
          code: "OUT_OF_STOCK",
          message: "Item is out of stock",
        });
      }

      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_STOCK",
        message: "Requested quantity exceeds stock",
      });
    }

    const subtotal = Number(reservedItem.price || 0) * qty;
    let order;
    try {
      const profile = req.user?.profile && typeof req.user.profile === "object" ? req.user.profile : {};

      order = await StoreOrder.create({
        userId,
        buyerSnapshot: {
          username: cleanString(req.user?.username),
          nickname: cleanString(profile.nickname),
          name: cleanString(profile.name),
          firstName: cleanString(profile.firstName),
          lastName: cleanString(profile.lastName),
          email: cleanString(req.user?.email).toLowerCase(),
        },
        items: [
          {
            sku: reservedItem.sku,
            type: reservedItem.type,
            name: reservedItem.name,
            qty,
            unitPrice: reservedItem.price,
            currency: reservedItem.currency || "GBP",
            imageUrl:
              reservedItem.images?.thumbUrl || reservedItem.images?.previewUrl || "",
          },
        ],
        subtotal,
        currency: reservedItem.currency || "GBP",
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
    } catch (orderErr) {
      // Best-effort rollback so stock is restored if order creation fails.
      await StoreItem.updateOne({ _id: reservedItem._id }, { $inc: { stockQty: qty } }).catch(
        () => {}
      );
      throw orderErr;
    }

    return res.json({
      ok: true,
      message: "Order created",
      stripeReady: false,
      item: withInventoryState({
        sku: reservedItem.sku,
        stockQty: Number(reservedItem.stockQty || 0),
        updatedAt: reservedItem.updatedAt || new Date(),
      }),
      meta: {
        sku: reservedItem.sku,
        serverTimeMs: Date.now(),
      },
      order,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to create order" });
  }
}

async function findOrderForUser(orderId, userId) {
  if (!orderId || !userId) return null;
  return StoreOrder.findOne({ _id: orderId, userId }).lean();
}

async function resolveIntentForOrder(order) {
  if (!order) return null;
  const byRef = cleanString(order.paymentIntentRef);
  if (byRef) {
    const intentByRef = await PaymentIntent.findOne({ intentId: byRef }).lean();
    if (intentByRef) return intentByRef;
  }
  if (order.paymentIntentId) {
    const intentById = await PaymentIntent.findById(order.paymentIntentId).lean();
    if (intentById) return intentById;
  }
  return null;
}

export async function createCheckoutOrder(req, res) {
  try {
    if (!paymentsV2Enabled()) {
      return res.status(503).json({
        ok: false,
        code: "PAYMENTS_DISABLED",
        message: "Payments are currently disabled.",
      });
    }

    const userId = userIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    return createOrderWithPaymentLifecycle(req, res, userId);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to create checkout order",
    });
  }
}

export async function syncCheckoutOrderPayment(req, res) {
  try {
    const userId = userIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orderId = cleanString(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "Missing orderId" });
    }

    const order = await findOrderForUser(orderId, userId);
    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    if (upper(order.paymentFlowVersion) !== "V2") {
      return res.status(400).json({
        ok: false,
        message: "This order is not using the new checkout flow.",
      });
    }

    const intent = await resolveIntentForOrder(order);
    if (!intent) {
      return res.status(404).json({
        ok: false,
        message: "Payment intent not found for this order.",
      });
    }

    const intentStatus = upper(intent.status || "PENDING_PAYMENT");
    const reservationExpired =
      upper(order.reservationStatus) === "RESERVED" &&
      order.reservationExpiresAt &&
      new Date(order.reservationExpiresAt).getTime() <= Date.now();
    if (
      reservationExpired &&
      ["CREATED", "PENDING_PAYMENT", "PROCESSING"].includes(intentStatus)
    ) {
      const release = await releaseReservedStockIfNeeded(order);
      const expiredOrder = await StoreOrder.findByIdAndUpdate(
        order._id,
        {
          paymentStatus: "FAILED",
          orderStatus: "CANCELLED",
          reservationStatus: "RELEASED",
          paymentUpdatedAt: new Date(),
        },
        { new: true }
      ).lean();
      return res.json({
        ok: true,
        expired: true,
        releasedStock: !!release?.released,
        order: expiredOrder,
        paymentIntent: paymentIntentSummary(intent),
      });
    }

    const mapped = orderStatusFromIntentStatus(intentStatus);
    let nextOrder = order;

    if (mapped.reservationStatus === "RELEASED") {
      if (upper(order.reservationStatus) === "RESERVED") {
        const release = await releaseReservedStockIfNeeded(order);
        nextOrder = release.order || order;
        nextOrder = await StoreOrder.findByIdAndUpdate(
          nextOrder._id,
          {
            paymentStatus: mapped.paymentStatus,
            orderStatus: mapped.orderStatus,
            reservationStatus: "RELEASED",
            paymentUpdatedAt: new Date(),
          },
          { new: true }
        ).lean();
      } else {
        // For already-consumed stock, keep reservation as-is to avoid accidental restock.
        nextOrder = await StoreOrder.findByIdAndUpdate(
          order._id,
          {
            paymentStatus:
              upper(order.paymentStatus) === "PAID" ? order.paymentStatus : mapped.paymentStatus,
            orderStatus:
              upper(order.orderStatus) === "PROCESSING"
                ? order.orderStatus
                : mapped.orderStatus,
            paymentUpdatedAt: new Date(),
          },
          { new: true }
        ).lean();
      }
    } else if (mapped.reservationStatus === "CONSUMED") {
      if (upper(order.reservationStatus) === "RELEASED") {
        return res.status(409).json({
          ok: false,
          code: "RESERVATION_ALREADY_RELEASED",
          message:
            "Order reservation was already released. Please create a new checkout.",
        });
      }

      nextOrder = await StoreOrder.findByIdAndUpdate(
        order._id,
        {
          paymentStatus: mapped.paymentStatus,
          orderStatus: mapped.orderStatus,
          reservationStatus: "CONSUMED",
          paymentUpdatedAt: new Date(),
        },
        { new: true }
      ).lean();
    } else {
      nextOrder = await StoreOrder.findByIdAndUpdate(
        order._id,
        {
          paymentStatus: mapped.paymentStatus,
          orderStatus: mapped.orderStatus,
          reservationStatus:
            upper(order.reservationStatus) === "NONE"
              ? "RESERVED"
              : upper(order.reservationStatus),
          paymentUpdatedAt: new Date(),
        },
        { new: true }
      ).lean();
    }

    return res.json({
      ok: true,
      order: nextOrder,
      paymentIntent: paymentIntentSummary(intent),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to sync checkout order payment",
    });
  }
}

export async function cancelCheckoutOrder(req, res) {
  try {
    const userId = userIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const orderId = cleanString(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "Missing orderId" });
    }

    const order = await findOrderForUser(orderId, userId);
    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    if (upper(order.paymentFlowVersion) !== "V2") {
      return res.status(400).json({
        ok: false,
        message: "This order is not using the new checkout flow.",
      });
    }

    if (upper(order.paymentStatus) === "PAID") {
      return res.status(409).json({
        ok: false,
        code: "ORDER_ALREADY_PAID",
        message: "Paid orders cannot be cancelled from checkout.",
      });
    }

    const intent = await resolveIntentForOrder(order);
    if (intent && ["CREATED", "PENDING_PAYMENT", "PROCESSING"].includes(upper(intent.status))) {
      try {
        const provider = resolvePaymentProvider(intent.provider || paymentProviderName());
        const result = await provider.cancelPayment({ intent, payload: req.body || {} });
        intent.status = upper(result?.status || "CANCELLED");
        if (cleanString(result?.providerPaymentId)) {
          intent.providerPaymentId = cleanString(result.providerPaymentId);
        }
        if (cleanString(result?.providerReference)) {
          intent.providerReference = cleanString(result.providerReference);
        }
      } catch (_) {
        intent.status = "CANCELLED";
      }
      intent.statusTimeline = [
        ...(Array.isArray(intent.statusTimeline) ? intent.statusTimeline : []),
        {
          status: "CANCELLED",
          at: new Date(),
          note: "Shop checkout cancelled by user",
          actor: "store_api",
        },
      ];
      await PaymentIntent.updateOne(
        { _id: intent._id },
        {
          status: intent.status,
          providerPaymentId: intent.providerPaymentId,
          providerReference: intent.providerReference,
          statusTimeline: intent.statusTimeline,
        }
      ).catch(() => {});
    }

    const release = await releaseReservedStockIfNeeded(order);
    const nextOrder = await StoreOrder.findByIdAndUpdate(
      order._id,
      {
        paymentStatus: "FAILED",
        orderStatus: "CANCELLED",
        reservationStatus: "RELEASED",
        paymentUpdatedAt: new Date(),
      },
      { new: true }
    ).lean();

    return res.json({
      ok: true,
      releasedStock: !!release?.released,
      order: nextOrder,
      paymentIntent: paymentIntentSummary(intent),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message || "Failed to cancel checkout order",
    });
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

    const intentRefs = orders
      .map((o) => upper(o?.paymentIntentRef))
      .filter(Boolean);
    const intents = intentRefs.length
      ? await PaymentIntent.find({ intentId: { $in: intentRefs } })
          .select({
            intentId: 1,
            status: 1,
            provider: 1,
            environment: 1,
            checkoutUrl: 1,
            clientToken: 1,
            expiresAt: 1,
          })
          .lean()
      : [];
    const intentMap = new Map(intents.map((x) => [upper(x.intentId), x]));

    const normalizedOrders = orders.map((order) => {
      const ref = upper(order?.paymentIntentRef);
      const linked = ref ? intentMap.get(ref) : null;
      if (!linked) return order;
      return {
        ...order,
        paymentIntent: paymentIntentSummary(linked),
      };
    });

    return res.json({
      ok: true,
      orders: normalizedOrders,
      meta: {
        count: normalizedOrders.length,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load orders" });
  }
}

// --------------------------------------------------
// ADMIN - PRODUCTS
// --------------------------------------------------

export async function adminListItems(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const type = normalizeType(req.query.type);
    const q = cleanString(req.query.q);
    const activeRaw = cleanString(req.query.active).toLowerCase();
    const status = normalizeType(req.query.status);

    const filter = {};
    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) {
      filter.type = type;
    }

    // status takes precedence over legacy active=true/false query.
    if (status === "ACTIVE") {
      filter.active = true;
      filter.stockQty = { $gt: 0 };
    } else if (status === "DISABLED") {
      filter.active = false;
    } else if (status === "SOLDOUT" || status === "SOLD_OUT") {
      filter.stockQty = { $lte: 0 };
    } else {
      if (activeRaw === "true") filter.active = true;
      if (activeRaw === "false") filter.active = false;
    }

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } },
        { tags: { $elemMatch: { $regex: q, $options: "i" } } },
      ];
    }

    const items = await StoreItem.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const normalized = items.map((item) => withInventoryState(item));
    const catalogVersionMs = await latestCatalogVersionMs(filter);

    return res.json({
      ok: true,
      items: normalized,
      meta: {
        count: normalized.length,
        status: status || (activeRaw ? (activeRaw === "true" ? "ACTIVE" : "DISABLED") : "ALL"),
        catalogVersionMs,
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to load admin items" });
  }
}

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
    const visibility = normalizeVisibility(body.visibility || "GLOBAL");
    const gallery =
      Array.isArray(body.images?.gallery)
        ? body.images.gallery.map((x) => cleanString(x)).filter(Boolean)
        : [];
    const thumbUrl = cleanString(body.images?.thumbUrl) || gallery[0] || "";
    const previewUrl =
      cleanString(body.images?.previewUrl) || gallery[1] || thumbUrl;

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
        thumbUrl,
        previewUrl,
        gallery,
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
      active: stockQty > 0 ? body.active !== false : false,
      visibility,
      sortOrder: Number(body.sortOrder || 0),
    });

    const normalized = withInventoryState(item?.toObject ? item.toObject() : item);
    return res.status(201).json({
      ok: true,
      item: normalized,
      meta: {
        inventoryVersionMs: normalized?.inventoryVersionMs || 0,
        serverTimeMs: Date.now(),
      },
    });
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

export async function adminUploadItemImage(req, res) {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Image file is required" });
    }

    const mime = cleanString(req.file.mimetype).toLowerCase();
    if (!mime.startsWith("image/")) {
      return res.status(400).json({ ok: false, message: "Only image files are allowed" });
    }

    const ownerRef = cleanString(req.clubId || req.club?._id || userIdFromReq(req) || "unknown");
    const uploaded = await uploadStoreImageToCloudinary({
      file: req.file,
      ownerRef,
    });

    const url = cleanString(uploaded?.secure_url || uploaded?.url);
    if (!url) {
      throw new Error("Upload succeeded but image URL was not returned");
    }

    return res.status(201).json({
      ok: true,
      image: {
        url,
        publicId: cleanString(uploaded?.public_id),
        width: Number(uploaded?.width || 0),
        height: Number(uploaded?.height || 0),
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to upload image" });
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
    const current = await StoreItem.findOne({ sku }).lean();
    if (!current) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    if (body.type != null) patch.type = normalizeType(body.type);
    if (body.name != null) patch.name = cleanString(body.name);
    if (body.description != null) patch.description = cleanString(body.description);
    if (body.currency != null) patch.currency = cleanString(body.currency).toUpperCase();
    if (body.price != null) patch.price = Number(body.price);
    if (body.stockQty != null) patch.stockQty = Math.max(0, Number(body.stockQty));
    if (body.rarity != null) patch.rarity = normalizeType(body.rarity);
    if (body.active != null) patch.active = !!body.active;
    if (body.visibility != null) {
      patch.visibility = normalizeVisibility(body.visibility);
    }
    if (body.sortOrder != null) patch.sortOrder = Number(body.sortOrder);
    if (body.weightKg != null) patch.weightKg = Number(body.weightKg);

    if (body.images) {
      const existingGallery = Array.isArray(current.images?.gallery)
        ? current.images.gallery.map((x) => cleanString(x)).filter(Boolean)
        : [];
      const hasGallery =
        Object.prototype.hasOwnProperty.call(body.images, "gallery");
      const nextGallery = hasGallery
        ? Array.isArray(body.images.gallery)
          ? body.images.gallery.map((x) => cleanString(x)).filter(Boolean)
          : []
        : existingGallery;

      const nextThumb =
        cleanString(body.images.thumbUrl) ||
        nextGallery[0] ||
        cleanString(current.images?.thumbUrl);
      const nextPreview =
        cleanString(body.images.previewUrl) ||
        nextGallery[1] ||
        nextThumb ||
        cleanString(current.images?.previewUrl);

      patch.images = {
        thumbUrl: nextThumb,
        previewUrl: nextPreview,
        gallery: nextGallery,
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

    const nextStockQty =
      patch.stockQty != null ? Number(patch.stockQty) : Number(current.stockQty || 0);
    if (nextStockQty <= 0) {
      // Keep sold-out items non-active until organizer restocks.
      patch.active = false;
    }

    const item = await StoreItem.findOneAndUpdate({ sku }, patch, {
      new: true,
      runValidators: true,
    }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    const normalized = withInventoryState(item);
    return res.json({
      ok: true,
      item: normalized,
      meta: {
        inventoryVersionMs: normalized?.inventoryVersionMs || 0,
        serverTimeMs: Date.now(),
      },
    });
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

    const item = await StoreItem.findOneAndDelete({ sku }).lean();

    if (!item) {
      return res.status(404).json({ ok: false, message: "Item not found" });
    }

    return res.json({
      ok: true,
      message: "Item deleted",
      item: withInventoryState(item),
      meta: {
        deletedSku: item?.sku || "",
        serverTimeMs: Date.now(),
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to delete item" });
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
      .populate({
        path: "userId",
        select: "username email profile.nickname profile.name profile.firstName profile.lastName",
      })
      .sort({ createdAt: -1 })
      .lean();

    const normalized = orders.map((order) => {
      const buyer = order?.userId && typeof order.userId === "object" ? order.userId : null;
      const buyerName = displayBuyerNameFromSources({ buyer, order });
      const buyerUsername = cleanString(
        order?.buyerSnapshot?.username || buyer?.username || order?.buyerUsername || order?.username
      );
      return {
        ...order,
        buyerName,
        buyerUsername: looksLikeOpaqueId(buyerUsername) ? "" : buyerUsername,
      };
    });

    return res.json({
      ok: true,
      orders: normalized,
      meta: {
        count: normalized.length,
        serverTimeMs: Date.now(),
      },
    });
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
