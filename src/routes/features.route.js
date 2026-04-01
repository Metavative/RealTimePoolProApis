import express from "express";
import { v2FeatureStatus } from "../controllers/features.controller.js";

const router = express.Router();

router.get("/status", v2FeatureStatus);

export default router;
