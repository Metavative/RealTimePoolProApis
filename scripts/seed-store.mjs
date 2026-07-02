// scripts/seed-store.mjs
//
// Seed a small, realistic store catalogue so the in-app Shop isn't empty for
// demos. Idempotent: upserts by SKU (safe to re-run; won't duplicate). Items are
// marked active. Payments being off in prod means these display but cannot be
// purchased — zero transaction risk.
//
// Run: node scripts/seed-store.mjs   (add --remove to delete just these seeded SKUs)
//
import "dotenv/config";
import mongoose from "mongoose";
import StoreItem from "../src/models/storeItem.model.js";

const img = (seed) => `https://picsum.photos/seed/poolpro-${seed}/600/600`;

const ITEMS = [
  // ---- Cues ----
  { sku: "CUE-ASH-STD", type: "CUE", name: "Ashwood Classic Cue", rarity: "COMMON",
    price: 39.99, stockQty: 50, description: "Traditional ash-shaft two-piece cue with a 9.5mm tip. A dependable all-rounder.", weightKg: 0.55 },
  { sku: "CUE-MAPLE-PRO", type: "CUE", name: "Maple Pro Series Cue", rarity: "RARE",
    price: 89.99, stockQty: 30, description: "Hand-spliced maple cue with a low-deflection shaft for tighter cue-ball control.", weightKg: 0.54 },
  { sku: "CUE-CARBON-X", type: "CUE", name: "Carbon-X Tournament Cue", rarity: "EPIC",
    price: 199.99, stockQty: 15, description: "Carbon-fibre shaft, quick-release joint and a leather wrap. Built for competition.", weightKg: 0.52 },
  { sku: "CUE-PHANTOM-LE", type: "CUE", name: "Phantom Limited Edition", rarity: "LEGENDARY",
    price: 349.99, stockQty: 5, description: "Numbered limited-edition cue with an ebony butt and abalone inlays.", weightKg: 0.53 },

  // ---- Tables ----
  { sku: "TBL-HOME-6FT", type: "TABLE", name: "Home 6ft Slate Table", rarity: "COMMON",
    price: 599.0, stockQty: 8, description: "Compact 6ft slate-bed table with tournament cloth. Ideal for home games rooms.", weightKg: 120 },
  { sku: "TBL-CLUB-7FT", type: "TABLE", name: "Club 7ft Pro Table", rarity: "RARE",
    price: 999.0, stockQty: 5, description: "7ft club-spec table with cushioned rails and a drop-pocket return system.", weightKg: 180 },
  { sku: "TBL-ARENA-9FT", type: "TABLE", name: "Arena 9ft Championship Table", rarity: "EPIC",
    price: 2499.0, stockQty: 2, description: "Full-size 9ft championship table with triple-slate bed and pro-grade worsted cloth.", weightKg: 320 },

  // ---- Accessories ----
  { sku: "ACC-CHALK-3PK", type: "ACCESSORY", name: "Master Chalk (3 pack)", rarity: "COMMON",
    price: 4.99, stockQty: 200, description: "Classic blue master chalk. Consistent grip, minimal residue. Pack of three.", weightKg: 0.05 },
  { sku: "ACC-GLOVE-PRO", type: "ACCESSORY", name: "Pro Shooting Glove", rarity: "COMMON",
    price: 12.99, stockQty: 120, description: "Breathable three-finger glove for a smooth, consistent bridge in any humidity.", weightKg: 0.04 },
  { sku: "ACC-CASE-HARD", type: "ACCESSORY", name: "Hard Shell Cue Case", rarity: "RARE",
    price: 44.99, stockQty: 40, description: "Impact-resistant 2x2 hard case with a plush interior and combination lock.", weightKg: 1.2 },
  { sku: "ACC-TRIANGLE-PRO", type: "ACCESSORY", name: "Precision Triangle Rack", rarity: "COMMON",
    price: 8.99, stockQty: 150, description: "Tight-tolerance moulded rack for a perfect rack every time.", weightKg: 0.15 },
];

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
if (!uri) {
  console.error("No MONGO_URI in .env.");
  process.exit(1);
}

const remove = process.argv.includes("--remove");

try {
  await mongoose.connect(uri);
  console.log(`database: ${mongoose.connection.name}`);

  if (remove) {
    const skus = ITEMS.map((i) => i.sku);
    const res = await StoreItem.deleteMany({ sku: { $in: skus } });
    console.log(`removed ${res.deletedCount} seeded items.`);
  } else {
    let created = 0;
    let updated = 0;
    for (let i = 0; i < ITEMS.length; i++) {
      const it = ITEMS[i];
      const doc = {
        ...it,
        currency: "GBP",
        active: true,
        visibility: "GLOBAL",
        sortOrder: i,
        images: { thumbUrl: img(it.sku), previewUrl: img(it.sku), gallery: [img(it.sku)] },
        tags: [it.type.toLowerCase(), it.rarity.toLowerCase()],
      };
      const existing = await StoreItem.findOne({ sku: it.sku }).select("_id").lean();
      await StoreItem.findOneAndUpdate({ sku: it.sku }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
      if (existing) updated++;
      else created++;
    }
    const total = await StoreItem.countDocuments({ active: true });
    console.log(`created ${created}, updated ${updated}. Active store items now: ${total}`);
  }
} catch (err) {
  console.error("Seed failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
