import express from "express";
import {
  signUp,
  login,

  // login (single-channel OTP)
  requestOtp,
  verifyOtp,

  // signup (multi-channel OTP)
  requestSignupOtp,

  forgotPassword,
  resetPassword,
  clerkLogin,

  // legacy phone endpoints (exported in controller, no crash)
  phoneRegisterRequestOtp,
  phoneRegisterVerifyOtp,
  phoneLoginRequestOtp,
  phoneLoginVerifyOtp,
} from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", signUp);
router.post("/login", login);
router.post("/signin", login);

// ✅ Signup OTP (send to BOTH email + phone if available)
router.post("/otp/request-signup", requestSignupOtp);

// ✅ Canonical OTP endpoints (login single-channel)
router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);

// Aliases
router.post("/otp/send", requestOtp);
router.post("/otp/resend", requestOtp);
router.post("/otp/request-otp", requestOtp);
router.post("/otp/validate", verifyOtp);
router.post("/otp/confirm", verifyOtp);

router.post("/forgot", forgotPassword);
router.post("/reset", resetPassword);

// ✅ Legacy phone endpoints (kept for compatibility)
router.post("/phone/register", phoneRegisterRequestOtp);
router.post("/phone/verify", phoneRegisterVerifyOtp);
router.post("/phone/login", phoneLoginRequestOtp);
router.post("/phone/login/verify", phoneLoginVerifyOtp);

router.post("/clerk", clerkLogin);

export default router;
