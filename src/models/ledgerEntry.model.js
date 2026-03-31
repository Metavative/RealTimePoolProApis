import mongoose from "mongoose";

const LedgerEntrySchema = new mongoose.Schema(
  {
    entryId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    intentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentIntent",
      default: null,
      index: true,
    },

    direction: {
      type: String,
      required: true,
      enum: ["DEBIT", "CREDIT"],
      trim: true,
      uppercase: true,
      index: true,
    },

    accountType: {
      type: String,
      required: true,
      enum: [
        "USER_WALLET",
        "ORGANIZER_BALANCE",
        "PLATFORM_REVENUE",
        "PRIZE_POOL",
        "REFERRAL_COMMISSION",
        "HOLD_BALANCE",
        "SYSTEM_ADJUSTMENT",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    accountId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    amountMinor: {
      type: Number,
      required: true,
      min: 1,
    },

    currency: {
      type: String,
      default: "GBP",
      trim: true,
      uppercase: true,
    },

    status: {
      type: String,
      default: "POSTED",
      enum: ["PENDING", "POSTED", "REVERSED", "FAILED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    sourceType: {
      type: String,
      default: "PAYMENT_INTENT",
      enum: [
        "PAYMENT_INTENT",
        "PAYOUT",
        "SETTLEMENT",
        "REFUND",
        "HOLD",
        "WITHDRAWAL",
        "MANUAL",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    sourceId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

LedgerEntrySchema.index({ accountType: 1, accountId: 1, createdAt: -1 });
LedgerEntrySchema.index({ sourceType: 1, sourceId: 1 });

export default mongoose.models.LedgerEntry ||
  mongoose.model("LedgerEntry", LedgerEntrySchema);
