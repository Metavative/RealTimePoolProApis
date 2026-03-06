import mongoose from "mongoose";

const StoreOrderItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, uppercase: true },
    type: {
      type: String,
      required: true,
      enum: ["CUE", "TABLE", "ACCESSORY"],
      uppercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 1, default: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "GBP", enum: ["GBP"] },
    imageUrl: { type: String, default: "" },
  },
  { _id: false }
);

const StoreOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    items: {
      type: [StoreOrderItemSchema],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "Order must contain at least one item",
      },
    },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      default: "GBP",
      enum: ["GBP"],
      uppercase: true,
      trim: true,
    },

    paymentStatus: {
      type: String,
      default: "PENDING",
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
      uppercase: true,
      index: true,
    },

    orderStatus: {
      type: String,
      default: "PENDING",
      enum: [
        "PENDING",
        "PROCESSING",
        "SHIPPED",
        "DELIVERED",
        "CANCELLED",
      ],
      uppercase: true,
      index: true,
    },

    stripeSessionId: {
      type: String,
      default: "",
      index: true,
      sparse: true,
    },

    shippingAddress: {
      fullName: { type: String, default: "" },
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      county: { type: String, default: "" },
      postcode: { type: String, default: "" },
      country: { type: String, default: "UK" },
      phone: { type: String, default: "" },
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

export default mongoose.models.StoreOrder ||
  mongoose.model("StoreOrder", StoreOrderSchema);