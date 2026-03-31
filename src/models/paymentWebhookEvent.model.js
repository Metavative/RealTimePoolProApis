import mongoose from "mongoose";

const PaymentWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    provider: {
      type: String,
      default: "MOCK",
      enum: ["MYPOS", "STRIPE", "PAYPAL", "MOCK", "UNKNOWN"],
      trim: true,
      uppercase: true,
      index: true,
    },

    providerEventId: {
      type: String,
      default: "",
      trim: true,
      sparse: true,
      index: true,
    },

    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    eventType: {
      type: String,
      default: "UNKNOWN",
      trim: true,
      uppercase: true,
      index: true,
    },

    signature: {
      type: String,
      default: "",
      trim: true,
    },

    sourceIp: {
      type: String,
      default: "",
      trim: true,
    },

    headers: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      default: "RECEIVED",
      enum: ["RECEIVED", "VERIFIED", "PROCESSED", "IGNORED", "FAILED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    processedAt: {
      type: Date,
      default: null,
      index: true,
    },

    linkedIntentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentIntent",
      default: null,
      index: true,
    },

    lastError: {
      type: String,
      default: "",
      trim: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

PaymentWebhookEventSchema.index(
  { provider: 1, providerEventId: 1 },
  { sparse: true }
);
PaymentWebhookEventSchema.index({ provider: 1, eventType: 1, createdAt: -1 });
PaymentWebhookEventSchema.index({ provider: 1, dedupeKey: 1 }, { unique: true });

export default mongoose.models.PaymentWebhookEvent ||
  mongoose.model("PaymentWebhookEvent", PaymentWebhookEventSchema);
