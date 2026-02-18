import mongoose from "mongoose";
const { Schema } = mongoose;

const TournamentInviteSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true, index: true },

    // ✅ FIX: this is a club id in your controller (req.clubId)
    organizerId: { type: Schema.Types.ObjectId, ref: "Club", required: true, index: true },

    toUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    toUsername: { type: String, required: true, trim: true, index: true },

    participantKey: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "cancelled"],
      default: "pending",
      index: true,
    },

    message: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

// one invite per tournament per user
TournamentInviteSchema.index({ tournamentId: 1, toUserId: 1 }, { unique: true });

export default mongoose.model("TournamentInvite", TournamentInviteSchema);
