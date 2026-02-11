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

  // Search users
  router.get("/search", auth, searchFriends);

  // Send friend request
  router.post("/request", auth, (req, res) => sendRequest(req, res, io, presence));

  // Respond to friend request (accept/reject)
  router.post("/respond", auth, (req, res) => respond(req, res, io, presence));

  // List incoming/outgoing requests
  // GET /api/friend/requests?type=incoming|outgoing
  router.get("/requests", auth, (req, res) => listRequests(req, res));

  // List friends
  // GET /api/friend/list
  router.get("/list", auth, (req, res) => listFriends(req, res, presence));
  router.get("/search", authAny, searchFriends);

  return router;
}
