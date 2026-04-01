import mongoose from "mongoose";

const ReferralCommissionSchema = new mongoose.Schema(
  {
    commissionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
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

    sourceModule: {
      type: String,
      default: "MATCH",
      enum: ["MATCH", "LEVEL_MATCH", "TOURNAMENT", "SHOP", "MANUAL", "OTHER"],
      trim: true,
      uppercase: true,
      index: true,
    },

    sourceRefId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    referrerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    currency: {
      type: String,
      default: "GBP",
      trim: true,
      uppercase: true,
      index: true,
    },

    sourceCommissionMinor: {
      type: Number,
      required: true,
      min: 0,
    },

    payoutMinor: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      default: "SETTLED",
      enum: ["PENDING", "SETTLED", "FAILED", "CANCELLED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    ledgerSourceId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      sparse: true,
      index: true,
    },

    paidAt: {
      type: Date,
      default: null,
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

ReferralCommissionSchema.index({ referrerUserId: 1, createdAt: -1 });
ReferralCommissionSchema.index({ referredUserId: 1, createdAt: -1 });
ReferralCommissionSchema.index({ sourceModule: 1, sourceRefId: 1 });

export default mongoose.models.ReferralCommission ||
  mongoose.model("ReferralCommission", ReferralCommissionSchema);
