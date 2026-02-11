import mongoose from "mongoose";

const TournamentMatchSchema = new mongoose.Schema(
    {
        tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", index: true, required: true },

        stage: { type: String, enum: ["GROUP", "PLAYOFF"], required: true, index: true },
        groupId: { type: String, trim: true, default: "" },
        round: { type: Number, default: 1, index: true },

        matchNo: {type: Number, default:1},

        teamA: {type: String, trim: true, required: true},
        teamB: {type: String, trim: true, required: true},

        venue: {type: String, trim: true, default: ""},
        dateTime: {type: Date, default: null},

        scoreA: {type: Number, default: 0},
        scoreB: {type: Number, default: 0},

        status: {type: String, enum: ["scheduled", "played"], default: "scheduled", index: true},

        nextMatch: {type: mongoose.Schema.Types.ObjectId, ref: "TournamentMatch", default: null},
        nextSlot: {type: String, enum: ["A", "B", ""], default: ""},
    },
    { timestamps: true }
);

TournamentMatchSchema.index({ tournamentId: 1, stage: 1, groupId: 1, round: 1, matchNo: 1});

export default mongoose.models.TournamentMatch || mongoose.model("TournamentMatch", TournamentMatchSchema);