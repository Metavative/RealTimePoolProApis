import mongoose from "mongoose";

const TournamentEntrantSchema = new mongoose.Schema(
  {
    entrantId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // optional
    name: { type: String, trim: true, default: "" },

    // stable key: uid:<id> | un:<usernameLower> | nm:<nameLower>
    participantKey: { type: String, trim: true, default: "" },
    username: { type: String, trim: true, default: "" },
    userId: { type: String, trim: true, default: "" }, // string id copy (optional)
    isLocal: { type: Boolean, default: false },

    rating: { type: Number, default: 0 },
    seed: { type: Number, default: 0 },
  },
  { _id: false }
);

const TournamentGroupSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true }, // "A"
    name: { type: String, trim: true }, // "Group A"

    // ✅ participantKeys (NOT ObjectIds)
    members: { type: [String], default: [] },
  },
  { _id: false }
);

const TournamentMatchSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true }, // g_A_1, po_r1_1 etc.

    // Optional: set only when teamA/teamB are uid:<mongoId>
    teamAId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    teamBId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // ✅ participantKey strings (uid:/un:/nm: or BYE)
    teamA: { type: String, trim: true, default: "" },
    teamB: { type: String, trim: true, default: "" },

    teamAName: { type: String, trim: true, default: "" },
    teamBName: { type: String, trim: true, default: "" },

    venue: { type: String, trim: true, default: "" },
    dateTime: { type: Date, default: null },

    scoreA: { type: Number, default: 0 },
    scoreB: { type: Number, default: 0 },

    status: { type: String, enum: ["scheduled", "played"], default: "scheduled" },
  },
  { _id: false }
);

const TournamentSchema = new mongoose.Schema(
  {
    clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", index: true },

    title: { type: String, trim: true, default: "" },

    accessMode: {
      type: String,
      enum: ["OPEN", "INVITE_ONLY"],
      default: "INVITE_ONLY",
    },

    entriesStatus: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
    },

    formatStatus: {
      type: String,
      enum: ["DRAFT", "FINALISED"],
      default: "DRAFT",
    },

    formatConfig: { type: Object, default: {} },

    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "COMPLETED"],
      default: "DRAFT",
    },

    startedAt: { type: Date },

    format: {
      type: String,
      enum: ["round_robin", "knockout", "double_elim", "group_stage"],
      default: "group_stage",
      index: true,
    },

    // Entrants (persisted)
    entrants: { type: [TournamentEntrantSchema], default: [] },

    // Group-stage config
    groupCount: { type: Number, default: 2 },
    groupSize: { type: Number, default: 0 },
    groupRandomize: { type: Boolean, default: true },

    // Qualifiers
    topNPerGroup: { type: Number, default: 1 },

    // Generated group assignments
    groups: { type: [TournamentGroupSchema], default: [] },

    // Matches (group + playoffs)
    matches: { type: [TournamentMatchSchema], default: [] },

    playoffDefaultVenue: { type: String, trim: true, default: "" },

    championName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.Tournament || mongoose.model("Tournament", TournamentSchema);
