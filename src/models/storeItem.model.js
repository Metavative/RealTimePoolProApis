import mongoose from "mongoose";

const StoreItemSchema = new mongoose.Schema(
  {
    sku: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      uppercase: true,
    },

    type: {
      type: String,
      required: true,
      enum: ["CUE", "TABLE", "ACCESSORY"],
      trim: true,
      uppercase: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    images: {
      thumbUrl: { type: String, default: "" },
      previewUrl: { type: String, default: "" },
    },

    currency: {
      type: String,
      default: "GBP",
      enum: ["GBP"],
      trim: true,
      uppercase: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    stockQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    rarity: {
      type: String,
      default: "COMMON",
      enum: ["COMMON", "RARE", "EPIC", "LEGENDARY"],
      trim: true,
      uppercase: true,
    },

    tags: {
      type: [String],
      default: [],
    },

    weightKg: {
      type: Number,
      default: 0,
      min: 0,
    },

    dimensions: {
      lengthCm: { type: Number, default: 0, min: 0 },
      widthCm: { type: Number, default: 0, min: 0 },
      heightCm: { type: Number, default: 0, min: 0 },
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export default mongoose.models.StoreItem ||
  mongoose.model("StoreItem", StoreItemSchema);