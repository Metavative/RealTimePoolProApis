import mongoose from "mongoose";

const UserLoadoutSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },

    activeCueSku: { type: String, default: "" },
    activeTableSku: { type: String, default: "" },
    accessorySkus: { type: [String], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model("UserLoadout", UserLoadoutSchema);
