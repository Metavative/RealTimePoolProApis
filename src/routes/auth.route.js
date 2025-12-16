import express from "express";
import * as authctrl from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", authctrl.signUp);

router.post("/login", authctrl.login);
router.post("/signin", authctrl.login);

router.post("/otp/request", authctrl.requestOtp);
router.post("/otp/verify", authctrl.verifyOtp);

router.post("/forgot", authctrl.forgotPassword);
router.post("/reset", authctrl.resetPassword);

router.post("/clerk", authctrl.clerkLogin);

export default router;
