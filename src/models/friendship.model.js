import mongoose from "mongoose";
const { Schema } = mongoose;

const FriendshipSchema = new Schema(
  {
    a: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    b: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

FriendshipSchema.index({ a: 1, b: 1 }, { unique: true });

export default mongoose.models.Friendship ||
  mongoose.model("Friendship", FriendshipSchema);
