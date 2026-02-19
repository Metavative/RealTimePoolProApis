import mongoose from "mongoose";

const UserEntitlementSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sku: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ["CUE", "TABLE", "ACCESSORY"] },

    source: { type: String, default: "COINS", enum: ["COINS", "IAP", "ADMIN"] },
    txId: { type: String, default: "" },
  },
  { timestamps: true }
);

// prevent duplicate ownership
UserEntitlementSchema.index({ userId: 1, sku: 1 }, { unique: true });

export default mongoose.model("UserEntitlement", UserEntitlementSchema);
