// src/routes/friend.routes.js
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

  // ✅ Search users (supports user tokens and hybrid venue/player tokens)
  router.get("/search", authAny, searchFriends);

  // ✅ These all work for normal users AND venue accounts because authMiddleware
  // maps playable club tokens to req.user / req.userId
  router.post("/request", auth, (req, res) => sendRequest(req, res, io, presence));
  router.post("/respond", auth, (req, res) => respond(req, res, io, presence));
  router.get("/requests", auth, (req, res) => listRequests(req, res));
  router.get("/list", auth, (req, res) => listFriends(req, res, presence));

  return router;
}