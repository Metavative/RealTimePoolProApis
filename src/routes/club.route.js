import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
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

router.post("/", authMiddleware, clubCtrl.createClub);
router.get("/nearby", authMiddleware, clubCtrl.listNearby);
router.post("/booking", authMiddleware, clubCtrl.createBooking);

// ✅ STEP 3: Organizer verification document upload
// Flutter should call: POST /api/club/verification/documents
// form-data:
// - venue_name (text)
// - venue_address (text)
// - business_license (file: pdf)
router.post(
  "/verification/documents",
  authMiddleware,
  upload.single("business_license"),
  clubCtrl.uploadVerificationDocuments
);

export default router;
