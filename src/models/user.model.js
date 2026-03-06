import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema({
  avatar: String,
  name: String,
  feedback: String,
  createdAt: { type: Date, default: Date.now },
});

const ProfileSchema = new mongoose.Schema({
  nickname: String,

  // ✅ KYC-ready identity fields
  firstName: { type: String, default: "" },
  lastName: { type: String, default: "" },
  legalName: { type: String, default: "" },

  // ✅ Good to explicitly define (your authController writes these)
  role: { type: String, default: "" },
  userType: { type: String, default: "" },

  avatar: { type: String, default: "" },
  highestLevelAchieve: String,
  musicPlayer: { type: Boolean, default: true },
  homeTable: String,
  minLevel: { type: Number, default: 1 },
  maxLevel: { type: Number, default: 100 },
  disputePercentage: { type: Number, default: 0 },
  disputeWinPercentage: { type: Number, default: 0 },
  matchAcceptancePercentage: { type: Number, default: 100 },
  refusalPercentage: { type: Number, default: 0 },
  fairPlay: { type: Number, default: 5.0 },
  verified: { type: Boolean, default: false },
  solidPlayer: { type: Boolean, default: false },
  veryCompetitive: { type: String, default: "" },
  onlineStatus: { type: Boolean, default: false },
  onLiveStream: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },

  organizer: { type: mongoose.Schema.Types.Mixed, default: null },
});

const EarningsSchema = new mongoose.Schema({
  yearToDate: [Number],
  career: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  withdrawable: { type: Boolean, default: true },
  entryFeesPaid: { type: Number, default: 0 },
  availableBalance: { type: Number, default: 0 },
  transactionHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: "Transaction" }],
});

const StatsSchema = new mongoose.Schema({
  userIdTag: { type: String, unique: true, sparse: true },
  rank: { type: String, default: "Beginner" },
  score: { type: Number, default: 0 },
  totalWinnings: { type: Number, default: 0 },
  bestWinStreak: { type: Number, default: 0 },
  currentWinStreak: { type: Number, default: 0 },
  winRate: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 },
  gamesLost: { type: Number, default: 0 },
  gamesDrawn: { type: Number, default: 0 },
  avgMatchDurationMinutes: { type: Number, default: 0 },
  tournaments: { type: Number, default: 0 },
  disputeHistoryCount: { type: Number, default: 0 },
});

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "support",
  "help",
  "system",
  "moderator",
  "mod",
  "player",
  "null",
  "undefined",
  "root",
]);

function cleanName(v) {
  const s = (v ?? "").toString().trim().replace(/\s+/g, " ");
  return s;
}

const UserSchema = new mongoose.Schema({
  email: { type: String, index: true, unique: true, sparse: true, trim: true, lowercase: true },
  phone: { type: String, index: true, unique: true, sparse: true, trim: true },

  // ✅ Public username handle
  username: { type: String, trim: true, default: null },
  usernameLower: {
    type: String,
    trim: true,
    lowercase: true,
    default: null,
    index: true,
    unique: true,
    sparse: true,
  },

  emailVerified: { type: Boolean, default: false, index: true },
  phoneVerified: { type: Boolean, default: false, index: true },

  lastOtpSent: { type: Date, default: null },
  lastOtpChannel: { type: String, enum: ["email", "phone", "multi", null], default: null },

  passwordHash: { type: String, select: false },

  clerkId: { type: String, index: true, unique: true, sparse: true },
  googleId: { type: String, index: true, unique: true, sparse: true },
  facebookId: { type: String, index: true, unique: true, sparse: true },
  appleId: { type: String, index: true, unique: true, sparse: true },

  profile: ProfileSchema,
  feedbacks: [FeedbackSchema],
  earnings: EarningsSchema,
  stats: StatsSchema,
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdAt: { type: Date, default: Date.now },

  otp: {
    code: String,
    expiresAt: Date,
  },

  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] },
  },

  lastSeen: { type: Date, default: Date.now },
});

UserSchema.index({ location: "2dsphere" });

UserSchema.pre("save", function (next) {
  if (this.email) this.email = String(this.email).trim().toLowerCase();
  if (this.phone) this.phone = String(this.phone).trim();

  // username normalization + validation
  if (this.username) {
    const raw = String(this.username).trim();

    if (!USERNAME_REGEX.test(raw)) {
      return next(new Error("Invalid username. Use 3-20 characters: letters, numbers, underscore."));
    }

    const lower = raw.toLowerCase();
    if (RESERVED_USERNAMES.has(lower)) {
      return next(new Error("This username is reserved. Please choose another."));
    }

    this.username = raw;
    this.usernameLower = lower;
  } else {
    this.usernameLower = null;
  }

  // Profile name normalization
  if (this.profile) {
    if (typeof this.profile.firstName === "string") this.profile.firstName = cleanName(this.profile.firstName);
    if (typeof this.profile.lastName === "string") this.profile.lastName = cleanName(this.profile.lastName);

    const fn = cleanName(this.profile.firstName || "");
    const ln = cleanName(this.profile.lastName || "");
    if ((!this.profile.legalName || !String(this.profile.legalName).trim()) && (fn || ln)) {
      this.profile.legalName = cleanName(`${fn} ${ln}`.trim());
    } else if (typeof this.profile.legalName === "string") {
      this.profile.legalName = cleanName(this.profile.legalName);
    }

    if (!this.profile.avatar || this.profile.avatar === "") {
      if (this.profile.nickname && this.profile.nickname.length > 0) {
        this.profile.avatar = this.profile.nickname[0].toUpperCase();
      } else if (this.profile.firstName && this.profile.firstName.length > 0) {
        this.profile.avatar = this.profile.firstName[0].toUpperCase();
      } else {
        this.profile.avatar = "?";
      }
    }
  }

  next();
});

export default mongoose.models.User || mongoose.model("User", UserSchema);