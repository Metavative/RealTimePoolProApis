import mongoose from 'mongoose';
const { Schema } = mongoose;


const FriendRequestSchema = new Schema({
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected' ], default: 'pending'},
    createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('FriendRequest', FriendRequestSchema)