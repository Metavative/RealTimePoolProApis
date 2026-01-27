import express from "express";
import {
  signUp,
  login,
  requestOtp,
  verifyOtp,
  forgotPassword,
  resetPassword,
  clerkLogin,

  // ✅ Phone (Twilio Verify) OTP-only auth
  phoneRegisterRequestOtp,
  phoneRegisterVerifyOtp,
  phoneLoginRequestOtp,
  phoneLoginVerifyOtp,
} from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", signUp);

router.post("/login", login);
router.post("/signin", login);

// Canonical OTP endpoints
router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);

// Aliases (organizer/customer mismatch protection)
router.post("/otp/send", requestOtp);
router.post("/otp/resend", requestOtp);
router.post("/otp/request-otp", requestOtp);
router.post("/otp/validate", verifyOtp);
router.post("/otp/confirm", verifyOtp);

router.post("/forgot", forgotPassword);
router.post("/reset", resetPassword);

// ✅ Phone OTP-only auth (Twilio Verify)
router.post("/phone/register", phoneRegisterRequestOtp);
router.post("/phone/verify", phoneRegisterVerifyOtp);
router.post("/phone/login", phoneLoginRequestOtp);
router.post("/phone/login/verify", phoneLoginVerifyOtp);

// Keep only if you really use Clerk
router.post("/clerk", clerkLogin);

export default router;
