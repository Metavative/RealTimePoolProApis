import express from "express";
import {
  clubSignUp,
  clubLogin,

  // login (single-channel OTP)
  clubRequestOtp,
  clubVerifyOtp,

  // signup (multi-channel OTP)
  clubRequestSignupOtp,
} from "../controllers/clubAuthController.js";

const router = express.Router();

router.post("/signup", clubSignUp);
router.post("/login", clubLogin);
router.post("/signin", clubLogin);

// ✅ Signup OTP (send to BOTH email + phone if available)
router.post("/otp/request-signup", clubRequestSignupOtp);

// ✅ Canonical OTP endpoints (login single-channel)
router.post("/otp/request", clubRequestOtp);
router.post("/otp/verify", clubVerifyOtp);

// Aliases
router.post("/otp/send", clubRequestOtp);
router.post("/otp/resend", clubRequestOtp);
router.post("/otp/request-otp", clubRequestOtp);
router.post("/otp/validate", clubVerifyOtp);
router.post("/otp/confirm", clubVerifyOtp);

export default router;
