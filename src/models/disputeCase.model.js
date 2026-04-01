import mongoose from "mongoose";

const DisputeEvidenceSchema = new mongoose.Schema(
  {
    type: { type: String, default: "TEXT", trim: true, uppercase: true },
    url: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    uploadedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DisputeCommentSchema = new mongoose.Schema(
  {
    actorType: { type: String, default: "USER", trim: true, uppercase: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorClubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", default: null },
    message: { type: String, default: "", trim: true },
    stance: { type: String, default: "", trim: true, uppercase: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DisputeResolutionSchema = new mongoose.Schema(
  {
    decidedByType: { type: String, default: "", trim: true, uppercase: true },
    decidedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedByClubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", default: null },
    decision: { type: String, default: "NO_FAULT", trim: true, uppercase: true },
    payoutAction: { type: String, default: "NO_CHANGE", trim: true, uppercase: true },
    payoutAmountMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "GBP", trim: true, uppercase: true },
    payoutApplied: { type: Boolean, default: false },
    payoutAppliedAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false }
);

const DisputeCaseSchema = new mongoose.Schema(
  {
    caseId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    module: {
      type: String,
      default: "MATCH",
      enum: ["MATCH", "LEVEL_MATCH", "TOURNAMENT", "SHOP", "OTHER"],
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

    openedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    respondentUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    organizerClubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
      default: null,
      index: true,
    },

    status: {
      type: String,
      default: "OPEN",
      enum: ["OPEN", "IN_REVIEW", "ESCALATED", "RESOLVED", "REJECTED", "CANCELLED"],
      trim: true,
      uppercase: true,
      index: true,
    },

    reason: {
      type: String,
      default: "",
      trim: true,
    },

    claimedAmountMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    currency: {
      type: String,
      default: "GBP",
      trim: true,
      uppercase: true,
    },

    evidence: {
      type: [DisputeEvidenceSchema],
      default: [],
    },

    comments: {
      type: [DisputeCommentSchema],
      default: [],
    },

    resolution: {
      type: DisputeResolutionSchema,
      default: () => ({}),
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

DisputeCaseSchema.index({ module: 1, moduleRefId: 1, createdAt: -1 });
DisputeCaseSchema.index({ openedByUserId: 1, createdAt: -1 });
DisputeCaseSchema.index({ respondentUserId: 1, createdAt: -1 });
DisputeCaseSchema.index({ organizerClubId: 1, status: 1, createdAt: -1 });

export default mongoose.models.DisputeCase || mongoose.model("DisputeCase", DisputeCaseSchema);
