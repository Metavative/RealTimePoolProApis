import mongoose from "mongoose";

const LevelMatchSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },

    challengerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    opponentUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    level: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      index: true,
    },

    currency: {
      type: String,
      default: "GBP",
      trim: true,
      uppercase: true,
      index: true,
    },

    stakeMinor: {
      type: Number,
      required: true,
      min: 1,
    },

    totalPotMinor: {
      type: Number,
      required: true,
      min: 2,
    },

    payoutMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    commissionMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      default: "CREATED",
      enum: [
        "CREATED",
        "FUNDS_HELD",
        "ONGOING",
        "SETTLED",
        "CANCELLED",
        "EXPIRED",
      ],
      trim: true,
      uppercase: true,
      index: true,
    },

    challengerHoldId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      index: true,
      sparse: true,
    },

    opponentHoldId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      index: true,
      sparse: true,
    },

    challengerHoldAccountId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    opponentHoldAccountId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    winnerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    loserUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    settlementId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      sparse: true,
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

    startedAt: {
      type: Date,
      default: null,
      index: true,
    },

    endedAt: {
      type: Date,
      default: null,
      index: true,
    },

    cancelledAt: {
      type: Date,
      default: null,
      index: true,
    },

    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },

    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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

LevelMatchSessionSchema.index({ participants: 1, createdAt: -1 });
LevelMatchSessionSchema.index({ challengerUserId: 1, opponentUserId: 1, status: 1 });

export default mongoose.models.LevelMatchSession ||
  mongoose.model("LevelMatchSession", LevelMatchSessionSchema);

