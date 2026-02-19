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
    members: { type: [String], default: [] }, // participantKeys
  },
  { _id: false }
);

const TournamentMatchSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true }, // g_A_1, po_r1_1 etc.

    teamAId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    teamBId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    teamA: { type: String, trim: true, default: "" }, // participantKey or BYE
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

// ✅ Step 3: structured formatConfig (still stored under tournament.formatConfig)
const TournamentFormatConfigSchema = new mongoose.Schema(
  {
    // organizer picks
    groupCount: { type: Number, default: 2 },
    qualifiersPerGroup: { type: Number, default: 1 },

    knockoutType: {
      type: String,
      enum: ["SINGLE_ELIM"],
      default: "SINGLE_ELIM",
    },

    thirdPlacePlayoff: { type: Boolean, default: false },

    // optional knobs (kept for compatibility)
    groupRandomize: { type: Boolean, default: true },
    groupBalanced: { type: Boolean, default: true },
    enableKnockoutStage: { type: Boolean, default: true },
  },
  { _id: false }
);

const TournamentSchema = new mongoose.Schema(
  {
    clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", index: true },

    title: { type: String, trim: true, default: "" },

    defaultVenue: { type: String, trim: true, default: "" },

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

    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Club", default: null },

    // ✅ Step 3: DRAFT → CONFIGURED → FINALISED
    formatStatus: {
      type: String,
      enum: ["DRAFT", "CONFIGURED", "FINALISED"],
      default: "DRAFT",
    },

    // ✅ Step 3: typed config (instead of plain Object)
    formatConfig: { type: TournamentFormatConfigSchema, default: () => ({}) },

    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "LIVE", "COMPLETED"],
      default: "DRAFT",
    },

    startedAt: { type: Date, default: null },

    format: {
      type: String,
      enum: ["round_robin", "knockout", "double_elim", "group_stage"],
      default: "group_stage",
      index: true,
    },

    entrants: { type: [TournamentEntrantSchema], default: [] },

    // legacy/compat (services + Flutter already use these)
    groupCount: { type: Number, default: 2 },
    groupSize: { type: Number, default: 0 },
    groupRandomize: { type: Boolean, default: true },
    groupBalanced: { type: Boolean, default: true },
    topNPerGroup: { type: Number, default: 1 },
    enableKnockoutStage: { type: Boolean, default: true },

    groups: { type: [TournamentGroupSchema], default: [] },
    matches: { type: [TournamentMatchSchema], default: [] },

    playoffDefaultVenue: { type: String, trim: true, default: "" },

    championName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

export default mongoose.models.Tournament || mongoose.model("Tournament", TournamentSchema);
