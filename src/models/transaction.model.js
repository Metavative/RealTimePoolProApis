import mongoose from "mongoose";
const TransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  amount: Number,
  type: { type: String, enum: ["credit","debit","entry_fee","payout","refund"] },
  status: { type: String, enum: ["pending","completed","failed"], default: "pending" },
  meta: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
export default mongoose.model("Transaction", TransactionSchema);
