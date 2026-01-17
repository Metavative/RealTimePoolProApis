// src/routes/clubAuth.route.js
import express from "express";
import {
  clubSignUp,
  clubLogin,
  clubRequestOtp,
  clubVerifyOtp,
} from "../controllers/clubAuthController.js";

const router = express.Router();

router.post("/signup", clubSignUp);
router.post("/login", clubLogin);
router.post("/signin", clubLogin);

router.post("/otp/request", clubRequestOtp);
router.post("/otp/verify", clubVerifyOtp);

router.post("/otp/send", clubRequestOtp);
router.post("/otp/resend", clubRequestOtp);
router.post("/otp/request-otp", clubRequestOtp);
router.post("/otp/validate", clubVerifyOtp);
router.post("/otp/confirm", clubVerifyOtp);

export default router;
