import express from "express";
import * as authctrl from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", authctrl.signUp);

router.post("/login", authctrl.login);
router.post("/signin", authctrl.login);

// Canonical OTP endpoints
router.post("/otp/request", authctrl.requestOtp);
router.post("/otp/verify", authctrl.verifyOtp);

// ✅ Aliases (organizer/customer often mismatch these)
router.post("/otp/send", authctrl.requestOtp);
router.post("/otp/resend", authctrl.requestOtp);
router.post("/otp/request-otp", authctrl.requestOtp);
router.post("/otp/validate", authctrl.verifyOtp);
router.post("/otp/confirm", authctrl.verifyOtp);

router.post("/forgot", authctrl.forgotPassword);
router.post("/reset", authctrl.resetPassword);

router.post("/clerk", authctrl.clerkLogin);

export default router;
