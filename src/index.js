import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import Http from "http";
import helmet from "helmet";
import { Server } from "socket.io";
import dotenv from "dotenv";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import colors from "colors";

import connectDb from "./config/db.js";
import connectCloudinary from "./config/cloudinary.config.js";

import User from "./models/user.model.js";

import authRoutes from "./routes/auth.route.js";
import userRoutes from "./routes/user.route.js";
import friendRoutes from "./routes/friend.route.js";
import matchRoutes from "./routes/match.route.js";
import clubRoutes from "./routes/club.route.js";
import bookingRoutes from "./routes/booking.route.js";
import zegoRoutes from "./routes/zego.route.js";

import registerMatchHandlers from "./services/socket_handler/matchHandler.js";

dotenv.config();

const app = express();

// Middleware setup
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// CORS setup
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000", // Restrict origin to your frontend URL or localhost
    credentials: true,
  })
);

// Logger
app.use(morgan("dev"));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // Limit requests to 200 per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/match", matchRoutes);
app.use("/api/club", clubRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/zego", zegoRoutes);

// Health check endpoint with additional logging
app.get("/api/health", (req, res) => {
  console.log("Health check endpoint hit");
  res.status(200).json({
    status: "ok",
    message: "Server is healthy",
    time: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: err.message,
  });
});

// Server and Socket.io setup
const server = Http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Presence map for online players
const presence = new Map();

// Routes
app.use("/api/friend", friendRoutes(io, presence));

// User status endpoint
app.get("/api/user/status/:id", (req, res) => {
  const { id } = req.params;
  res.json({ userId: String(id), online: presence.has(String(id)) });
});

// Emit online players to connected clients
async function emitOnlinePlayers() {
  const ids = Array.from(presence.keys());
  if (ids.length === 0) {
    io.emit("presence:update", []);
    return;
  }

  const users = await User.find({ _id: { $in: ids } })
    .select("profile.nickname profile.avatar profile.onlineStatus stats.rank stats.totalWinnings stats.userIdTag")
    .lean();

  io.emit("presence:update", users);
}

// Get nearby players based on the user's location
async function getNearbyPlayersForUser(userId, radiusKm = 5) {
  const me = await User.findById(userId).select("location profile.latitude profile.longitude").lean();
  if (!me) return [];

  const coords = me.location?.coordinates;
  if (!coords || coords.length !== 2) return [];

  const lng = coords[0];
  const lat = coords[1];

  const nearby = await User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .select("profile.nickname profile.avatar profile.onlineStatus stats.rank stats.totalWinnings stats.userIdTag location")
    .lean();

  return nearby;
}

// Socket.io connection handler
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  registerMatchHandlers(io, socket, presence);

  const setPresence = async (userId) => {
    const uid = String(userId || "");
    if (!uid) return;

    socket.userId = uid;
    presence.set(uid, socket.id);

    try {
      await User.findByIdAndUpdate(uid, {
        "profile.onlineStatus": true,
        lastSeen: new Date(),
      });
      await emitOnlinePlayers();
    } catch (err) {
      console.error("Error setting presence:", err);
    }
  };

  socket.on("userOnline", async (userId) => {
    await setPresence(userId);
  });

  socket.on("player:online", async (payload) => {
    if (!payload || !payload.userId || !payload.location) return;

    const { userId, location } = payload;
    const lat = location.lat;
    const lng = location.lng;

    const update = {
      "profile.onlineStatus": true,
      lastSeen: new Date(),
      location: { type: "Point", coordinates: [lng, lat] },
      "profile.latitude": lat,
      "profile.longitude": lng,
    };

    try {
      await User.findByIdAndUpdate(userId, update);
      await emitOnlinePlayers();

      if (typeof lat === "number" && typeof lng === "number") {
        const nearby = await getNearbyPlayersForUser(userId, 5);
        socket.emit("nearbyPlayers", nearby);
      }
    } catch (err) {
      console.error("Error updating player location:", err);
    }
  });

  socket.on("updateLocation", async (payload) => {
    if (!payload || !payload.userId || typeof payload.lat !== "number" || typeof payload.lng !== "number") {
      console.error("Invalid location update payload:", payload);
      return;
    }

    const { userId, lat, lng } = payload;
    try {
      await User.findByIdAndUpdate(userId, {
        location: { type: "Point", coordinates: [lng, lat] },
        "profile.latitude": lat,
        "profile.longitude": lng,
        lastSeen: new Date(),
      });

      const nearby = await getNearbyPlayersForUser(userId, 5);
      socket.emit("nearbyPlayers", nearby);
    } catch (err) {
      console.error("Error updating location:", err);
    }
  });

  socket.on("disconnect", async () => {
    const uid = socket.userId ? String(socket.userId) : "";
    if (uid) {
      presence.delete(uid);

      try {
        await User.findByIdAndUpdate(uid, {
          "profile.onlineStatus": false,
          lastSeen: new Date(),
        });
        await emitOnlinePlayers();
        console.log(`User offline: ${uid}`);
      } catch (err) {
        console.error("Error updating user status on disconnect:", err);
      }
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;

// Start server
(async () => {
  try {
    await connectDb();
    await connectCloudinary();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`.bgBrightGreen.black.bold);
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
})();

// Graceful shutdown on SIGINT
process.on("SIGINT", () => {
  console.log("\nServer shutting down...");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
