import mongoose from "mongoose";
import StoreItem from "../models/storeItem.model.js";
import UserEntitlement from "../models/userEntitlement.model.js";
import UserLoadout from "../models/userLoadout.model.js";
import User from "../models/user.model.js"; // adjust path if needed

function userIdFromReq(req) {
  // adjust if your auth middleware uses different shape
  return req.user?.id || req.user?._id;
}

export async function listItems(req, res) {
  try {
    const type = (req.query.type || "").toString().toUpperCase().trim();
    const filter = { active: true };
    if (["CUE", "TABLE", "ACCESSORY"].includes(type)) filter.type = type;

    const items = await StoreItem.find(filter).sort({ sortOrder: 1, createdAt: -1 }).lean();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load items" });
  }
}

export async function getItem(req, res) {
  try {
    const sku = (req.params.sku || "").toString().trim();
    const item = await StoreItem.findOne({ sku, active: true }).lean();
    if (!item) return res.status(404).json({ ok: false, message: "Item not found" });
    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load item" });
  }
}

export async function myEntitlements(req, res) {
  try {
    const userId = userIdFromReq(req);
    const ent = await UserEntitlement.find({ userId }).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, entitlements: ent });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load entitlements" });
  }
}

export async function myLoadout(req, res) {
  try {
    const userId = userIdFromReq(req);
    let loadout = await UserLoadout.findOne({ userId }).lean();
    if (!loadout) {
      const created = await UserLoadout.create({ userId });
      loadout = created.toObject();
    }
    return res.json({ ok: true, loadout });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "Failed to load loadout" });
  }
}

export async function purchase(req, res) {
  const session = await mongoose.startSession();
  try {
    const userId = userIdFromReq(req);
    const sku = (req.body?.sku || "").toString().trim();

    if (!sku) return res.status(400).json({ ok: false, message: "Missing sku" });

    const item = await StoreItem.findOne({ sku, active: true }).lean();
    if (!item) return res.status(404).json({ ok: false, message: "Item not found" });
    if (item.currency !== "COINS") return res.status(400).json({ ok: false, message: "Unsupported currency" });

    // already owned?
    const existing = await UserEntitlement.findOne({ userId, sku }).lean();
    if (existing) {
      const u = await User.findById(userId).select("coins").lean();
      return res.json({ ok: true, alreadyOwned: true, coins: u?.coins ?? 0 });
    }

    const price = Number(item.price || 0);

    let resultCoins = null;

    await session.withTransaction(async () => {
      // deduct coins atomically
      const u = await User.findOneAndUpdate(
        { _id: userId, coins: { $gte: price } },
        { $inc: { coins: -price } },
        { new: true, session, projection: { coins: 1 } }
      );

      if (!u) {
        throw new Error("INSUFFICIENT_COINS");
      }

      // create entitlement (unique index protects duplicates)
      await UserEntitlement.create(
        [
          {
            userId,
            sku,
            type: item.type,
            source: "COINS",
            txId: "",
          },
        ],
        { session }
      );

      resultCoins = u.coins;
    });

    return res.json({ ok: true, coins: resultCoins, sku, type: item.type });
  } catch (e) {
    const msg = e?.message || "Purchase failed";
    if (msg === "INSUFFICIENT_COINS") {
      return res.status(400).json({ ok: false, code: "INSUFFICIENT_COINS", message: "Not enough coins" });
    }
    // duplicate entitlement race: treat as success
    if (msg.includes("E11000")) {
      const userId = userIdFromReq(req);
      const u = await User.findById(userId).select("coins").lean();
      return res.json({ ok: true, alreadyOwned: true, coins: u?.coins ?? 0 });
    }
    return res.status(500).json({ ok: false, message: msg });
  } finally {
    session.endSession();
  }
}

async function assertOwned(userId, sku) {
  const ent = await UserEntitlement.findOne({ userId, sku }).lean();
  return !!ent;
}

export async function equip(req, res) {
  // TODO: implement
  return res.json({ ok: true, message: "equip stub" });
}
