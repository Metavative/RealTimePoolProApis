import mongoose from "mongoose";

const TournamentEntryOrderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tournament",
      required: true,
      index: true,
    },

    clubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
      default: null,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    intentId: {
      type: String,
      default: "",
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

    status: {
      type: String,
      default: "PENDING_PAYMENT",
      enum: ["PENDING_PAYMENT", "PAID", "FAILED", "CANCELLED", "EXPIRED", "REFUNDED"],
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

    platformMinor: {
      type: Number,
      default: 0,
      min: 0,
    },

    ledgerApplied: {
      type: Boolean,
      default: false,
      index: true,
    },

    entrantAdded: {
      type: Boolean,
      default: false,
      index: true,
    },

    paidAt: {
      type: Date,
      default: null,
      index: true,
    },

    settledAt: {
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

TournamentEntryOrderSchema.index({ tournamentId: 1, userId: 1, createdAt: -1 });

export default mongoose.models.TournamentEntryOrder ||
  mongoose.model("TournamentEntryOrder", TournamentEntryOrderSchema);
