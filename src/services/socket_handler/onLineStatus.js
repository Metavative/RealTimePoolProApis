// socketHandlers/onlineStatus.js
import User from "../../models/user.model.js";

export const onlineStatusHandler = (io, socket) => {
  console.log("⚡ Socket connected:", socket.id);

  socket.on("userOnline", async (userId) => {
    try {
      await User.findByIdAndUpdate(userId, {
        "profile.onlineStatus": true,
        "profile.lastSeen": new Date(),
      });

      socket.userId = userId;
      io.emit("userOnlineUpdate", { userId, status: true });
      console.log("✅ User online:", userId);
    } catch (err) {
      console.error("Error setting user online:", err);
    }
  });

  socket.on("updateLocation", async ({ userId, lat, lng }) => {
    try {
      await User.findByIdAndUpdate(userId, {
        "profile.latitude": lat,
        "profile.longitude": lng,
      });
    } catch (err) {
      console.error("Location update error:", err);
    }
  });

  socket.on("disconnect", async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, {
        "profile.onlineStatus": false,
        "profile.lastSeen": new Date(),
      });
      io.emit("userOnlineUpdate", { userId: socket.userId, status: false });
      console.log("🔌 Socket disconnected:", socket.id);
    }
  });
};
