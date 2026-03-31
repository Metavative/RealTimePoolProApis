import mongoose from "mongoose";

const PaymentStatusTimelineSchema = new mongoose.Schema(
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

const PaymentIntentSchema = new mongoose.Schema(
  {
    intentId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    module: {
      type: String,
      default: "SHOP",
      enum: [
        "SHOP",
        "MATCH",
        "TOURNAMENT",
        "WALLET_TOPUP",
        "WITHDRAWAL",
        "REFERRAL",
        "ADJUSTMENT",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    moduleRefId: {
      type: String,
      default: "",
      trim: true,
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

    environment: {
      type: String,
      default: "SANDBOX",
      enum: ["SANDBOX", "PRODUCTION"],
      trim: true,
      uppercase: true,
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

    commissionMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    organizerShareMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    prizePoolMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      default: "CREATED",
      enum: [
        "CREATED",
        "PENDING_PAYMENT",
        "PROCESSING",
        "PAID",
        "FAILED",
        "CANCELLED",
        "EXPIRED",
        "REFUNDED",
        "PARTIALLY_REFUNDED",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    providerPaymentId: {
      type: String,
      default: "",
      trim: true,
      index: true,
      sparse: true,
    },

    providerReference: {
      type: String,
      default: "",
      trim: true,
      index: true,
      sparse: true,
    },

    checkoutUrl: {
      type: String,
      default: "",
      trim: true,
    },

    clientToken: {
      type: String,
      default: "",
      trim: true,
    },

    idempotencyKey: {
      type: String,
      default: "",
      trim: true,
      index: true,
      sparse: true,
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    statusTimeline: {
      type: [PaymentStatusTimelineSchema],
      default: [],
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

PaymentIntentSchema.index({ userId: 1, createdAt: -1 });
PaymentIntentSchema.index({ module: 1, moduleRefId: 1 });
PaymentIntentSchema.index({ provider: 1, providerPaymentId: 1 }, { sparse: true });
PaymentIntentSchema.index({ userId: 1, idempotencyKey: 1 }, { sparse: true });

export default mongoose.models.PaymentIntent ||
  mongoose.model("PaymentIntent", PaymentIntentSchema);
