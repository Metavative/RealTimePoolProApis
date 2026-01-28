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
  email: {
    type: String,
    lowercase: true,
    trim: true,
    index: true,
    sparse: true,
  },
  phone: {
    type: String,
    trim: true,
    index: true,
    sparse: true,
  },

  // ✅ Verification flags for both channels
  emailVerified: { type: Boolean, default: false, index: true },
  phoneVerified: { type: Boolean, default: false, index: true },

  // ✅ OTP throttle / channel tracking (email + phone)
  lastOtpSent: { type: Date, default: null },
  lastOtpChannel: {
    type: String,
    enum: ["email", "phone"],
    default: null,
  },

  // Support both field names (same as User)
  passwordHash: { type: String, select: false },
  password: { type: String, select: false },

  otp: { type: OtpSchema, default: undefined },

  verified: { type: Boolean, default: false }, // legacy auth-level verified (keep)
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

  // Keep this field as-is (doesn't break existing logic)
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // legacy organizer link

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

export default mongoose.model("Club", ClubSchema);
