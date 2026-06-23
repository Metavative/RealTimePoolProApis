import mongoose from "mongoose";
import dotenv from "dotenv";
import colors from "colors";
dotenv.config();

// Tracks whether the connected deployment supports multi-document
// transactions (replica set / mongos). Several economy flows
// (level matches, referrals, disputes) open sessions/transactions and will
// throw on a standalone mongod. We detect this once and expose it so callers
// can degrade gracefully instead of failing mid-settlement.
let _supportsTransactions = false;

export function supportsTransactions() {
  return _supportsTransactions;
}

async function detectTransactionSupport(conn) {
  try {
    const admin = conn.connection.db.admin();
    const info = await admin.command({ hello: 1 });
    // `setName` present => replica set; `msg === "isdbgrid"` => mongos.
    const isReplicaSet = Boolean(info?.setName);
    const isMongos = info?.msg === "isdbgrid";
    _supportsTransactions = isReplicaSet || isMongos;
  } catch (e) {
    _supportsTransactions = false;
  }
  return _supportsTransactions;
}

const connectDb = async () => {
  try {
    if (!process.env.MONGO_URI || !String(process.env.MONGO_URI).trim()) {
      throw new Error("MONGO_URI is not set");
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: Number(process.env.MONGO_MAX_POOL || 20),
      minPoolSize: Number(process.env.MONGO_MIN_POOL || 0),
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECT_MS || 10000),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
    });

    console.log(`MongoDB connected: ${conn.connection.host}`.bgBrightBlue.bgBrightYellow);

    await detectTransactionSupport(conn);
    if (_supportsTransactions) {
      console.log("MongoDB supports multi-document transactions (replica set / mongos).");
    } else {
      console.warn(
        "⚠️  MongoDB is standalone — multi-document transactions are NOT supported. " +
          "Economy flows that rely on transactions (level matches, referrals, disputes) " +
          "may fail. Use a replica set in production."
      );
    }

    return conn;
  } catch (error) {
    console.log("Error in connectDb " + error);
    process.exit(1);
  }
};

export default connectDb;
