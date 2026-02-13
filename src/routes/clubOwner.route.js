import express from "express";
import { authAny } from "../middleware/authAny.middleware.js";
import { bindClubOwner } from "../controllers/clubOwner.controller.js";

export default function clubOwnerRoutes() {
  const router = express.Router();

  // Club-only: set owner ONCE
  // POST /api/club/owner/bind
  router.post("/owner/bind", authAny, bindClubOwner);

  return router;
}
