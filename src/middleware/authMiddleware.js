import User from "../models/user.model.js";
import { verify } from "../services/jwtService.js";

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const parts = String(header).trim().split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid Authorization format" });
    }

    const token = parts[1];
    const payload = verify(token);

    if (!payload || !payload.id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    const user = await User.findById(payload.id).select({ passwordHash: 0, otp: 0 });
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.userId = user._id;
    req.user = user;

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
