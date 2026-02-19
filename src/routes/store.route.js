import express from "express";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";
import {
  listItems,
  getItem,
  myEntitlements,
  myLoadout,
  purchase,
  equip,
} from "../controllers/store.controller.js";

const router = express.Router();

// public-ish catalog (you can make it auth if you prefer)
router.get("/items", listItems);
router.get("/items/:sku", getItem);

// user endpoints
router.get("/me/entitlements", auth, myEntitlements);
router.get("/me/loadout", auth, myLoadout);

router.post("/purchase", auth, purchase);
router.post("/equip", auth, equip);

export default router;
