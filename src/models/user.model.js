import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema({
  avatar: String,
  name: String,
  feedback: String,
  createdAt: { type: Date, default: Date.now },
});

const ProfileSchema = new mongoose.Schema({
  nickname: String,
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

const UserSchema = new mongoose.Schema({
  email: { type: String, index: true, unique: true, sparse: true },
  phone: { type: String, index: true, unique: true, sparse: true },

<<<<<<< HEAD
  // ✅ Twilio Verify phone auth flags
  phoneVerified: { type: Boolean, default: false, index: true },
  lastOtpSent: { type: Date, default: null },

=======
>>>>>>> 596c6fc785edc18a3da75574e8b94d521d22f762
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
  if (this.profile) {
    if (!this.profile.avatar || this.profile.avatar === "") {
      if (this.profile.nickname && this.profile.nickname.length > 0) {
        this.profile.avatar = this.profile.nickname[0].toUpperCase();
      } else {
        this.profile.avatar = "?";
      }
    }
  }
  next();
});

export default mongoose.model("User", UserSchema);
