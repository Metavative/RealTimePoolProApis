import mongoose, { mongo } from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const connectDb = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB connected: ${conn.connection.host}`.bgBrightBlue.bgBrightYellow);
    } catch (error) {
        console.log("Error in connectDb" + error);
        process.exit(1);
    }
}

export default connectDb;