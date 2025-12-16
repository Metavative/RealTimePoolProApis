import express from "express";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";

import {
  sendRequest,
  respond,
  searchFriends,
  createDummyIncomingRequest,
} from "../controllers/friendController.js";

/**
 * Friend routes need access to:
 * - io       → to emit socket events
 * - presence → to know who is online
 */
export default function friendRoutes(io, presence) {
  const router = express.Router();

  /**
   * Search friends
   * GET /api/friend/search?q=
   */
  router.get("/search", auth, searchFriends);

  /**
   * Send friend request
   * POST /api/friend/request
   * body: { toUserId }
   */
  router.post(
    "/request",
    auth,
    (req, res) => sendRequest(req, res, io, presence)
  );

  /**
   * Respond to friend request
   * POST /api/friend/respond
   * body: { requestId, accept }
   */
  router.post(
    "/respond",
    auth,
    (req, res) => respond(req, res, io, presence)
  );

  /**
   * Create dummy incoming request (dev/testing only)
   * POST /api/friend/dummy_incoming
   */
  router.post(
    "/dummy_incoming",
    auth,
    createDummyIncomingRequest
  );

  return router;
}
