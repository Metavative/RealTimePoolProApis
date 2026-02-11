import express from "express";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";
import { authAny } from "../middleware/authAny.middleware.js";

import {
  sendRequest,
  respond,
  searchFriends,
  listRequests,
  listFriends,
} from "../controllers/friendController.js";

export default function friendRoutes(io, presence) {
  const router = express.Router();

  // ✅ Search users (allow both club + user tokens)
  router.get("/search", authAny, searchFriends);

  // Send friend request (keep user auth only if that's your rule)
  router.post("/request", auth, (req, res) => sendRequest(req, res, io, presence));

  // Respond to friend request (accept/reject)
  router.post("/respond", auth, (req, res) => respond(req, res, io, presence));

  // List incoming/outgoing requests
  router.get("/requests", auth, (req, res) => listRequests(req, res));

  // List friends
  router.get("/list", auth, (req, res) => listFriends(req, res, presence));

  return router;
}
