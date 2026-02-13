// src/routes/club.route.js
import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { clubAuthMiddleware } from "../middleware/clubAuthMiddleware.js"; // ✅ NEW
import * as clubCtrl from "../controllers/clubController.js";
import multer from "multer";

const router = express.Router();

// ✅ Multer (PDF upload) - stored in memory (works great on Railway)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      String(file.originalname || "").toLowerCase().endsWith(".pdf");
    if (!ok) return cb(new Error("Only PDF files are allowed"));
    cb(null, true);
  },
});

// Keep existing behavior for now (player-auth or shared auth)
router.post("/", authMiddleware, clubCtrl.createClub);
router.get("/nearby", authMiddleware, clubCtrl.listNearby);
router.post("/booking", authMiddleware, clubCtrl.createBooking);

// ✅ NEW: Link club owner (Organizer user) to this club
// Requires CLUB token
// body: { ownerUserId: "<User _id>" }
router.post("/owner/link", clubAuthMiddleware, clubCtrl.linkClubOwner);

// ✅ STEP 3: Organizer verification document upload
// Now requires CLUB token
router.post(
  "/verification/documents",
  clubAuthMiddleware,
  upload.single("business_license"),
  clubCtrl.uploadVerificationDocuments
);

export default router;
