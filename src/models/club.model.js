// src/models/club.model.js
import mongoose from "mongoose";

const OtpSchema = new mongoose.Schema(
  {
    code: { type: String },
    expiresAt: { type: Date },
  },
  { _id: false }
);

const ClubSchema = new mongoose.Schema({
  // ======================
  // AUTH (Club Organizer)
  // ======================
  email: { type: String, lowercase: true, trim: true, index: true, sparse: true },
  phone: { type: String, trim: true, index: true, sparse: true },

  // Support both field names (same as User)
  passwordHash: { type: String, select: false },
  password: { type: String, select: false },

  otp: { type: OtpSchema, default: undefined },

  verified: { type: Boolean, default: false }, // OTP verified (auth-level)
  status: {
    type: String,
    enum: ["ACTIVE", "PENDING_VERIFICATION", "PENDING_REVIEW", "SUSPENDED"],
    default: "PENDING_VERIFICATION",
  },

  // ======================
  // CLUB DATA
  // ======================
  name: { type: String, trim: true },
  address: { type: String, trim: true },

  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
  },

  // Legacy organizer link (keep)
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  photos: [{ type: String }],
  contactPhone: { type: String, trim: true },

  schedule: [
    {
      day: { type: String },
      slots: [{ start: String, end: String, available: Boolean }],
    },
  ],

  // Verification documents (optional – safe placeholders)
  verification: {
    venueName: { type: String, trim: true },
    venueAddress: { type: String, trim: true },
    businessLicenseUrl: { type: String, trim: true },
    submittedAt: { type: Date },
  },

  createdAt: { type: Date, default: Date.now },
});

ClubSchema.index({ location: "2dsphere" });

// Avoid duplicates if provided (sparse keeps nulls allowed)
ClubSchema.index({ email: 1 }, { unique: true, sparse: true });
ClubSchema.index({ phone: 1 }, { unique: true, sparse: true });

ClubSchema.pre("save", function (next) {
  if (this.email) this.email = String(this.email).trim().toLowerCase();
  if (this.phone) this.phone = String(this.phone).trim();
  next();
});

// ✅ nodemon-safe export (prevents OverwriteModelError)
export default mongoose.models.Club || mongoose.model("Club", ClubSchema);
