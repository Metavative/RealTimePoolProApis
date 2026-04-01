import mongoose from "mongoose";

const PrizeAwardSchema = new mongoose.Schema(
  {
    awardId: {
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

    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    title: {
      type: String,
      default: "",
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    kind: {
      type: String,
      default: "CUP",
      enum: ["CUP", "PRIZE", "BADGE"],
      trim: true,
      uppercase: true,
      index: true,
    },

    trigger: {
      type: String,
      default: "SYSTEM",
      trim: true,
      uppercase: true,
      index: true,
    },

    sourceModule: {
      type: String,
      default: "OTHER",
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

    awardedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

PrizeAwardSchema.index({ userId: 1, code: 1 }, { unique: true });
PrizeAwardSchema.index({ userId: 1, awardedAt: -1 });

export default mongoose.models.PrizeAward || mongoose.model("PrizeAward", PrizeAwardSchema);
