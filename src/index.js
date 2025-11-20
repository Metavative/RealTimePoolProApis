import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import Http from "http";
import helmet from "helmet";
import { Server } from "socket.io";
import connectDb from "./config/db.js";
import dotenv from "dotenv";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import colors from "colors";
import connectCloudinary from "./config/cloudinary.config.js";

// ROUTES
import authRoutes from "./routes/auth.route.js";
import userRoutes from "./routes/user.route.js";
import friendRoutes from "./routes/friend.route.js";
import matchRoutes from "./routes/match.route.js";
import clubRoutes from "./routes/club.route.js";
import bookingRoutes from "./routes/booking.route.js";
import zegoRoutes from "./routes/zego.route.js";
import registerOnlinePlayerHandlers from "./services/socket_handler/onlinePlayers.js";
import { onlineStatusHandler } from "./services/socket_handler/onLineStatus.js";
import registerPresenceHandlers from "./services/socket_handler/presenceHandler.js"; 
import registerMatchHandlers from "./services/socket_handler/matchHandler.js";
dotenv.config();

// ====================== EXPRESS APP SETUP ======================
const app = express();

// Security & Parsing
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// CORS (Allow specific frontend in production)
app.use(
  cors({
    origin: process.env.CLIENT_URL || "*", // Set CLIENT_URL in .env
    credentials: true,
  })
);

// Request Logging
app.use(morgan("dev"));

// Rate Limiting (Adjust for prod)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // max requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ====================== ROUTES ======================
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
// app.use("/api/friend", friendRoutes);

app.use("/api/match", matchRoutes);
app.use("/api/club", clubRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/zego", zegoRoutes);

// Health Check Endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is healthy 💖",
    time: new Date().toISOString(),
  });
});

// ====================== ERROR HANDLER ======================
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: err.message,
  });
});

// ====================== SOCKET.IO SETUP ======================
const server = Http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
  },
});

// In-memory presence map (use Redis in production)
const presence = new Map();
app.use("/api/friend", friendRoutes(io, presence));

// REST API to check a single user's online status
app.get("/api/user/status/:id", (req, res) => {
  const { id } = req.params;
  const isOnline = presence.has(id);
  res.json({ userId: id, online: isOnline });
});

io.on("connection", (socket) => {
  console.log(`⚡ Socket connected: ${socket.id}`);
//     registerOnlinePlayerHandlers(io, socket);
//  onlineStatusHandler(io, socket)
   registerPresenceHandlers(io, socket, presence); 
  registerMatchHandlers(io, socket);

  // Identify user connection
  socket.on("identify", ({ userId }) => {
    if (!userId) return;
    socket.userId = userId;
    presence.set(userId, socket.id);

    // Notify all clients about online user
    io.emit("presence:update", {
      userId,
      status: "online",
      onlineUsers: Array.from(presence.keys()),
    });

    console.log(`🟢 User ${userId} is now online`);
  });

  // Friend invite
  socket.on("friend:invite", ({ fromUserId, toUserId }) => {
    const targetSocket = presence.get(toUserId);
    if (targetSocket) {
      io.to(targetSocket).emit("friend:invite", { fromUserId });
    }
  });

  // Challenge flow (send)
  socket.on("challenge:send", ({ fromUserId, toUserId, clubId, slot }) => {
    const targetSocket = presence.get(toUserId);
    const payload = { fromUserId, clubId, slot, timestamp: Date.now() };
    if (targetSocket) io.to(targetSocket).emit("challenge:received", payload);
  });

  // Challenge response
  socket.on("challenge:response", ({ toUserId, fromUserId, accepted, matchId }) => {
    const socketId = presence.get(toUserId);
    if (socketId) {
      io.to(socketId).emit("challenge:response", { fromUserId, accepted, matchId });
    }
  });

  // Match join
  socket.on("match:join", ({ roomId }) => {
    if (!roomId) return;
    socket.join(roomId);
    socket.to(roomId).emit("match:playerJoined", { userId: socket.userId });
  });

  // Match updates
  socket.on("match:update", ({ roomId, update }) => {
    if (!roomId) return;
    socket.to(roomId).emit("match:update", update);
  });

  // Booking notifications
  socket.on("booking:created", ({ clubId, booking }) => {
    io.emit("booking:created", { clubId, booking });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    if (socket.userId) {
      presence.delete(socket.userId);

      // Notify all clients about offline user
      io.emit("presence:update", {
        userId: socket.userId,
        status: "offline",
        onlineUsers: Array.from(presence.keys()),
      });

      console.log(`🔴 User ${socket.userId} went offline`);
    }

    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// ====================== SERVER START ======================
const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await connectDb();
    await connectCloudinary();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `✅ Server is running on port ${PORT}`.bgBrightGreen.black.bold
      );
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
})();

// ====================== GRACEFUL SHUTDOWN ======================
process.on("SIGINT", () => {
  console.log("\n🛑 Server shutting down...");
  server.close(() => {
    console.log("HTTP server closed. Goodbye 👋");
    process.exit(0);
  });
});


// import express from 'express';
// import cookieParser from "cookie-parser";
// import cors from 'cors';
// import Http from 'http';
// import helmet from "helmet";    
// import { Server } from "socket.io";
// import connectDb from './config/db.js';
// import dotenv from "dotenv";

// //Recored Time of Requests
// import morgan from 'morgan';

// //ROUTES
// import authRoutes from "./routes/auth.route.js"
// import userRoutes from "./routes/user.route.js"
// import friendRoutes from "./routes/friend.route.js"
// import matchRoutes from "./routes/match.route.js"
// import club from "./routes/club.route.js"
// import bookingRoute from "./routes/booking.route.js"
// import zegoRoute from "./routes/zego.route.js"

// //Styles
// import colors from 'colors';
// import connectCloudinary from './config/cloudinary.config.js';
// import rateLimit from 'express-rate-limit';

// //  ====================== ================== ========================= =================

// const app = express();

// app.use(helmet());
// app.use(express.json());
// app.use(cookieParser());
// app.use(cors());
// app.use(express.urlencoded({ extended: true }))
// app.use(morgan('dev'));
// dotenv.config();

// // Basic rate limiter (tweak in production )
// const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200});
// app.use(limiter);

// // Routes
// app.use("/api/auth", authRoutes);
// app.use("/api/user", userRoutes);
// app.use("/api/friend", friendRoutes);
// app.use("/api/match", matchRoutes);
// app.use("/api/club", club);
// app.use("/api/booking", bookingRoute)
// app.use("/api/zego", zegoRoute)

// app.post("/api/test", (req,res) => {
//     res.send({message: "Health is ok💖"});
// })
 
// // Socket.io setup
// const server = Http.createServer(app);
// const io = new Server(server, {
//     cors: {
//         origin: "*",
//         methods: ["GET", "POST"]
//     }
// });

// // In-memory presence map (use Redis in prod )
// const presence = new Map();

// io.on("connection", (socket) => {
//   console.log("socket connected:", socket.id);

//   // identify: client sends { userId, token? } after connecting
//   socket.on("identify", ({ userId }) => {
//     socket.userId = userId;
//     presence.set(userId, socket.id);
//     io.emit("presence:update", Array.from(presence.keys()));
//   });

//   // friend invite
//   socket.on("friend:invite", ({ fromUserId, toUserId }) => {
//     const targetSocket = presence.get(toUserId);
//     if (targetSocket) io.to(targetSocket).emit("friend:invite", { fromUserId });
//   });

//   // challenge flow
//   socket.on("challenge:send", ({ fromUserId, toUserId, clubId, slot }) => {
//     const targetSocket = presence.get(toUserId);
//     const payload = { fromUserId, clubId, slot, timestamp: Date.now() };
//     if (targetSocket) io.to(targetSocket).emit("challenge:received", payload);
//   });

//   socket.on("challenge:response", ({ toUserId, fromUserId, accepted, matchId }) => {
//     const socketId = presence.get(toUserId);
//     if (socketId) io.to(socketId).emit("challenge:response", { fromUserId, accepted, matchId });
//   });

//   // join match room
//   socket.on("match:join", ({ roomId }) => {
//     socket.join(roomId);
//     socket.to(roomId).emit("match:playerJoined", { userId: socket.userId });
//   });

//   // match updates (sync score, moves etc.)
//   socket.on("match:update", ({ roomId, update }) => {
//     socket.to(roomId).emit("match:update", update);
//   });

//   // booking notifications
//   socket.on("booking:created", ({ clubId, booking }) => {
//     // notify organizer clients — here simplistic broadcast
//     io.emit("booking:created", { clubId, booking });
//   });

//   socket.on("disconnect", () => {
//     if (socket.userId) {
//       presence.delete(socket.userId);
//       io.emit("presence:update", Array.from(presence.keys()));
//     }
//     console.log("socket disconnected:", socket.id);
//   });
// });
// const PORT = 4000;
//     connectDb();
//     connectCloudinary()
// server.listen(PORT, '0.0.0.0',  () => {
//     console.log(`Server is running on port ${PORT}`.bgBrightGreen.brightWhite);
// });