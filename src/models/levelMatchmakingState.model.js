import mongoose from "mongoose";

const LevelMatchmakingStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    live: {
      type: Boolean,
      default: false,
      index: true,
    },
    status: {
      type: String,
      default: "PAUSED",
      enum: ["LIVE", "PAUSED", "OFFLINE"],
      trim: true,
      uppercase: true,
      index: true,
    },
    preferredLevel: {
      type: Number,
      default: 1,
      min: 1,
      max: 100,
      index: true,
    },
    minLevel: {
      type: Number,
      default: 1,
      min: 1,
      max: 100,
    },
    maxLevel: {
      type: Number,
      default: 100,
      min: 1,
      max: 100,
    },
    radiusKm: {
      type: Number,
      default: 15,
      min: 1,
      max: 250,
    },
    autoAccept: {
      type: Boolean,
      default: false,
    },
    geo: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    lastHeartbeatAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastMatchedAt: {
      type: Date,
      default: null,
    },
    lastMatchedWithUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastSessionId: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

LevelMatchmakingStateSchema.index({ geo: "2dsphere" });
LevelMatchmakingStateSchema.index({ live: 1, status: 1, preferredLevel: 1, lastHeartbeatAt: -1 });

export default mongoose.models.LevelMatchmakingState ||
  mongoose.model("LevelMatchmakingState", LevelMatchmakingStateSchema);
