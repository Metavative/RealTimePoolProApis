import mongoose from "mongoose"
const { Schema } = mongoose;

const TournamentSchema = new Schema({
    name: String,
    organizer: {type: Schema.Types.ObjectId, ref: 'User'},
    schedule: {
        startDate: Date,
        endDate: Date,
    },
    entryFee: Number,
    participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now},
    meta: Schema.Types.Mixed
});

export default mongoose.model('Tournament', TournamentSchema)