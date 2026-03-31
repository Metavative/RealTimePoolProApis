import mongoose from "mongoose";

const SettlementLineSchema = new mongoose.Schema(
  {
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
    debitMinor: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditMinor: {
      type: Number,
      default: 0,
      min: 0,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

const SettlementSchema = new mongoose.Schema(
  {
    settlementId: {
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
      enum: ["SHOP", "MATCH", "TOURNAMENT", "DISPUTE", "REFERRAL", "ADJUSTMENT"],
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

    totalMinor: {
      type: Number,
      required: true,
      min: 0,
    },

    settledMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    outstandingMinor: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    status: {
      type: String,
      default: "OPEN",
      enum: ["OPEN", "PARTIAL", "SETTLED", "REVERSED", "FAILED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    settledAt: {
      type: Date,
      default: null,
      index: true,
    },

    lines: {
      type: [SettlementLineSchema],
      default: [],
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

SettlementSchema.index({ module: 1, moduleRefId: 1 });
SettlementSchema.index({ status: 1, updatedAt: -1 });

SettlementSchema.pre("validate", function computeOutstanding(next) {
  const total = Number(this.totalMinor || 0);
  const settled = Number(this.settledMinor || 0);
  this.outstandingMinor = Math.max(0, total - settled);
  next();
});

export default mongoose.models.Settlement ||
  mongoose.model("Settlement", SettlementSchema);

