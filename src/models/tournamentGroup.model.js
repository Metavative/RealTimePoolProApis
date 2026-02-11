import mongoose from "mongoose";

const TournamentGroupSchema = new mongoose.Schema(
    {
        tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", index: true, required: true },
        groupId: { type: String, trim: true, required: true },
        name: { type: String, trim: true, required: true },

        members: [{type: String, trim: true}],
    },
    { timestamps: true }
);

TournamentGroupSchema.index({ tournamentId: 1, groupId: 1 }, { unique: true });

export default mongoose.models.TournamentGroup || mongoose.model("TournamentGroup", TournamentGroupSchema);