import mongoose from "mongoose";
const MatchSchema = new mongoose.Schema({
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  status: { type: String, enum: ["pending","ongoing","finished","cancelled"], default: "pending" },
  score: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, points: Number }],
  winner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  entryFee: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  startAt: Date,
  endAt: Date,
  isLive: { type: Boolean, default: false },
  meta: mongoose.Schema.Types.Mixed
});
export default mongoose.model("Match", MatchSchema);
