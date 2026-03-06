import { authMiddleware } from "./authMiddleware.js";

function extractRole(user) {
  const candidates = [
    user?.role,
    user?.userType,
    user?.accountType,
    user?.profile?.role,
    user?.profile?.userType,
    user?.profile?.type,
  ];

  for (const c of candidates) {
    const s = String(c || "").trim().toLowerCase();
    if (s) return s;
  }
  return "";
}

export async function adminMiddleware(req, res, next) {
  return authMiddleware(req, res, async () => {
    try {
      const role = extractRole(req.user);

      const allowed =
        role.includes("admin") ||
        role.includes("organizer") ||
        role.includes("club") ||
        role.includes("venue");

      if (!allowed) {
        return res.status(403).json({
          ok: false,
          message: "Admin access required",
        });
      }

      return next();
    } catch (e) {
      return res.status(403).json({
        ok: false,
        message: "Admin access denied",
      });
    }
  });
}