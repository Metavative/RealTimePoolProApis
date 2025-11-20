import mongoose from "mongoose";
const ClubSchema = new mongoose.Schema({
  name: String,
  address: String,
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] } // [lng, lat]
  },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // organizer
  photos: [String],
  contactPhone: String,
  schedule: [{
    day: String,
    slots: [{ start: String, end: String, available: Boolean }]
  }],
  createdAt: { type: Date, default: Date.now }
});
ClubSchema.index({ location: "2dsphere" });
export default mongoose.model("Club", ClubSchema);
