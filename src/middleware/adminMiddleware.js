import { authMiddleware } from "./authMiddleware.js";
import { hasPlatformAdminAccess } from "../utils/authz.js";

export async function adminMiddleware(req, res, next) {
  return authMiddleware(req, res, async () => {
    try {
      // Platform-admin access requires an explicit admin signal (see
      // utils/authz.js). The legacy substring behaviour is only used when
      // AUTHZ_STRICT_ADMIN is explicitly disabled.
      if (!hasPlatformAdminAccess(req.user)) {
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