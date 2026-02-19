import mongoose from "mongoose";

const StoreItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true, enum: ["CUE", "TABLE", "ACCESSORY"] },

    name: { type: String, required: true },
    description: { type: String, default: "" },

    images: {
      thumbUrl: { type: String, default: "" },
      previewUrl: { type: String, default: "" },
    },

    currency: { type: String, default: "COINS", enum: ["COINS"] },
    price: { type: Number, required: true, min: 0 },

    rarity: {
      type: String,
      default: "COMMON",
      enum: ["COMMON", "RARE", "EPIC", "LEGENDARY"],
    },

    tags: { type: [String], default: [] },

    // optional later: effects you can apply in gameplay
    effects: { type: mongoose.Schema.Types.Mixed, default: {} },

    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("StoreItem", StoreItemSchema);
