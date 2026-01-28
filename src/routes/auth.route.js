import express from "express";
import {
  signUp,
  login,
  requestOtp,
  verifyOtp,
  forgotPassword,
  resetPassword,
  clerkLogin,
} from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", signUp);

router.post("/login", login);
router.post("/signin", login);

// Canonical OTP endpoints
router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);

// Aliases (client mismatch protection)
router.post("/otp/send", requestOtp);
router.post("/otp/resend", requestOtp);
router.post("/otp/request-otp", requestOtp);
router.post("/otp/validate", verifyOtp);
router.post("/otp/confirm", verifyOtp);

router.post("/forgot", forgotPassword);
router.post("/reset", resetPassword);

// Keep only if you really use Clerk
router.post("/clerk", clerkLogin);

export default router;
