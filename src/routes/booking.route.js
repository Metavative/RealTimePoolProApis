import express from "express";
import * as bc from "../controllers/bookingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();


router.get("/", authMiddleware, bc.listBookings);
router.post("/cancel", authMiddleware, bc.cancelBooking);


export default router;