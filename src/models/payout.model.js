import mongoose from "mongoose";

const PayoutStatusTimelineSchema = new mongoose.Schema(
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

const PayoutSchema = new mongoose.Schema(
  {
    payoutId: {
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

    clubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
      default: null,
      index: true,
    },

    provider: {
      type: String,
      default: "MOCK",
      enum: ["MYPOS", "STRIPE", "PAYPAL", "MOCK"],
      trim: true,
      uppercase: true,
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
      index: true,
    },

    feeMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    netAmountMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      default: "REQUESTED",
      enum: [
        "REQUESTED",
        "PENDING_REVIEW",
        "APPROVED",
        "PROCESSING",
        "PAID",
        "FAILED",
        "REJECTED",
        "CANCELLED",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    destinationType: {
      type: String,
      default: "BANK",
      enum: ["BANK", "CARD", "WALLET", "OTHER"],
      trim: true,
      uppercase: true,
    },

    destinationLast4: {
      type: String,
      default: "",
      trim: true,
    },

    providerPayoutId: {
      type: String,
      default: "",
      trim: true,
      sparse: true,
      index: true,
    },

    providerReference: {
      type: String,
      default: "",
      trim: true,
      sparse: true,
      index: true,
    },

    idempotencyKey: {
      type: String,
      default: "",
      trim: true,
      sparse: true,
      index: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    processedAt: {
      type: Date,
      default: null,
      index: true,
    },

    statusTimeline: {
      type: [PayoutStatusTimelineSchema],
      default: [],
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

PayoutSchema.index({ userId: 1, createdAt: -1 });
PayoutSchema.index({ userId: 1, status: 1, createdAt: -1 });
PayoutSchema.index({ userId: 1, idempotencyKey: 1 }, { sparse: true });
PayoutSchema.index({ provider: 1, providerPayoutId: 1 }, { sparse: true });

export default mongoose.models.Payout || mongoose.model("Payout", PayoutSchema);

