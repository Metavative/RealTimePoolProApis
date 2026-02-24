// src/models/tournament.model.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const EntrantSchema = new Schema(
  {
    entrantId: { type: Schema.Types.ObjectId, ref: "User", required: false },
    participantKey: { type: String, required: true }, // uid:<id> | un:<username> | nm:<name>:<ts>
    name: { type: String, default: "" },
    username: { type: String, default: "" },
    userId: { type: String, default: "" }, // string id for convenience
    isLocal: { type: Boolean, default: false },
    rating: { type: Number, default: 0 },
    seed: { type: Number, default: 0 },
  },
  { _id: false }
);

const GroupSchema = new Schema(
  {
    id: { type: String, required: true }, // A, B, C...
    name: { type: String, default: "" },
    members: { type: [String], default: [] }, // participantKeys
  },
  { _id: false }
);

const MatchSchema = new Schema(
  {
    id: { type: String, required: true }, // g_A_1, rr_1, ko_1, po_r1_1 ...
    teamA: { type: String, default: "" }, // participantKey or BYE
    teamB: { type: String, default: "" }, // participantKey or BYE

    teamAId: { type: Schema.Types.ObjectId, ref: "User", required: false },
    teamBId: { type: Schema.Types.ObjectId, ref: "User", required: false },

    teamAName: { type: String, default: "" },
    teamBName: { type: String, default: "" },

    venue: { type: String, default: "" },
    dateTime: { type: Date, default: null },

    scoreA: { type: Number, default: 0 },
    scoreB: { type: Number, default: 0 },

    status: { type: String, default: "scheduled" }, // scheduled | played
  },
  { _id: false }
);

const TournamentSchema = new Schema(
  {
    // ownership
    clubId: { type: Schema.Types.ObjectId, ref: "Club", required: false },

    // basic
    title: { type: String, default: "" },
    format: {
      type: String,
      default: "round_robin",
      enum: ["round_robin", "knockout", "group_stage", "double_elim", "double_elimination"],
    },

    status: {
      type: String,
      default: "DRAFT",
      enum: ["DRAFT", "ACTIVE", "LIVE", "COMPLETED"],
    },

    // step 2
    accessMode: { type: String, default: "INVITE_ONLY", enum: ["OPEN", "INVITE_ONLY"] },
    entriesStatus: { type: String, default: "OPEN", enum: ["OPEN", "CLOSED"] },

    // step 3
    formatStatus: { type: String, default: "DRAFT", enum: ["DRAFT", "CONFIGURED", "FINALISED"] },

    formatConfig: {
      groupCount: { type: Number, default: 2 },
      qualifiersPerGroup: { type: Number, default: 1 },
      knockoutType: { type: String, default: "SINGLE_ELIM" }, // optional future
      thirdPlacePlayoff: { type: Boolean, default: false },
      groupRandomize: { type: Boolean, default: true },
      groupBalanced: { type: Boolean, default: true },
      enableKnockoutStage: { type: Boolean, default: true },
    },

    // legacy mirrors (keep for compatibility with older clients)
    groupCount: { type: Number, default: 2 },
    groupSize: { type: Number, default: 0 },
    groupRandomize: { type: Boolean, default: true },
    groupBalanced: { type: Boolean, default: true },
    topNPerGroup: { type: Number, default: 1 },
    enableKnockoutStage: { type: Boolean, default: true },
    thirdPlacePlayoff: { type: Boolean, default: false },

    // venues
    defaultVenue: { type: String, default: "" },
    playoffDefaultVenue: { type: String, default: "" },

    // core arrays
    entrants: { type: [EntrantSchema], default: [] },
    groups: { type: [GroupSchema], default: [] },
    matches: { type: [MatchSchema], default: [] },

    // champion
    championName: { type: String, default: "" }, // stores participantKey

    // playoffs metadata (Step 4/5)
    playoffs: {
      generatedAt: { type: Date, default: null },
      qualifiersPerGroup: { type: Number, default: 0 },
      bracketSize: { type: Number, default: 0 },
      force: { type: Boolean, default: false },
      venue: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Tournament", TournamentSchema);