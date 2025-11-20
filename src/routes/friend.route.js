import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as friendCtrl from "../controllers/friendController.js"

// import { authMiddleware } from "../middlewares/auth.middleware.js"; // if you have auth

export default (io, presence) => {
  const router = express.Router();

  router.post("/send", authMiddleware, (req, res) => friendCtrl.sendRequest(req, res, io, presence));
  router.post("/respond", authMiddleware, (req, res) => friendCtrl.respond(req, res, io, presence));
  router.get("/search", authMiddleware, friendCtrl.searchFriends);

  return router;
};
