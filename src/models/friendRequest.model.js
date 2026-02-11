import mongoose from "mongoose";
const { Schema } = mongoose;

const FriendRequestSchema = new Schema(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

/**
 * Only one PENDING request allowed in the same direction
 */
FriendRequestSchema.index(
  { from: 1, to: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

FriendRequestSchema.index({ to: 1, status: 1 });

export default mongoose.models.FriendRequest ||
  mongoose.model("FriendRequest", FriendRequestSchema);
