import { verify } from "../services/jwtService.js";

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "Missing authorization" });
  const token = header.split(" ")[1];
  try {
    const payload = verify(token);
    req.userId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid token" });
  }
}