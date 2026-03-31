import mongoose from "mongoose";

const WalletHoldTimelineSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
    actor: {
      type: String,
      default: "system",
      trim: true,
    },
  },
  { _id: false }
);

const WalletHoldSchema = new mongoose.Schema(
  {
    holdId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    intentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentIntent",
      default: null,
      index: true,
    },

    currency: {
      type: String,
      default: "GBP",
      trim: true,
      uppercase: true,
    },

    amountMinor: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      default: "HELD",
      enum: ["HELD", "CAPTURED", "RELEASED", "EXPIRED", "CANCELLED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    reason: {
      type: String,
      default: "",
      trim: true,
    },

    targetAccountType: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    targetAccountId: {
      type: String,
      default: "",
      trim: true,
    },

    idempotencyKey: {
      type: String,
      default: "",
      trim: true,
      sparse: true,
      index: true,
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    capturedAt: {
      type: Date,
      default: null,
      index: true,
    },

    releasedAt: {
      type: Date,
      default: null,
      index: true,
    },

    statusTimeline: {
      type: [WalletHoldTimelineSchema],
      default: [],
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

WalletHoldSchema.index({ userId: 1, createdAt: -1 });
WalletHoldSchema.index({ userId: 1, status: 1, createdAt: -1 });
WalletHoldSchema.index({ userId: 1, idempotencyKey: 1 }, { sparse: true });

export default mongoose.models.WalletHold ||
  mongoose.model("WalletHold", WalletHoldSchema);

