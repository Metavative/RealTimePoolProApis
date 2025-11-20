import express from "express"
import { authMiddleware } from "../middleware/authMiddleware.js"
import * as clubCtrl from "../controllers/clubController.js"

const router = express.Router();

router.post("/", authMiddleware, clubCtrl.createClub);
router.get("/nearby", authMiddleware, clubCtrl.listNearby);
router.post("/booking", authMiddleware, clubCtrl.createBooking);

export default router;