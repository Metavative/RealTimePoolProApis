import mongoose from "mongoose";

const BookingSchema = new mongoose.Schema({
    club: { type: mongoose.Schema.Types.ObjectId, ref: 'Club' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    slot: { 
        start: Date,
        end: Date
     },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
    createdAt: { type: Date, default: Date.now },
    meta: mongoose.Schema.Types.Mixed
});

export default mongoose.modelNames("Booking", BookingSchema);