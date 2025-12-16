import mongoose from "mongoose";
const { Schema } = mongoose;

const FriendRequestSchema = new Schema(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

/**
 * ✅ VERY IMPORTANT
 * Prevents duplicate pending requests between same users
 * This is one of the hidden causes of:
 * - "request already exists"
 * - ghost requests
 * - inconsistent UI states
 */
FriendRequestSchema.index(
  { from: 1, to: 1 },
  { unique: true }
);

export default mongoose.model("FriendRequest", FriendRequestSchema);
