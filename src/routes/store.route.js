import express from "express";
import multer from "multer";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";
import {
  listItems,
  getItem,
  createOrder,
  myOrders,
  adminCreateItem,
  adminUploadItemImage,
  adminUpdateItem,
  adminDeleteItem,
  adminListOrders,
  adminUpdateOrderStatus,
} from "../controllers/store.controller.js";

const router = express.Router();
const storeImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ------------------------------
// Public / player catalog
// ------------------------------
router.get("/items", listItems);
router.get("/items/:sku", getItem);

// ------------------------------
// Player orders
// ------------------------------
router.get("/me/orders", auth, myOrders);
router.post("/orders", auth, createOrder);

// ------------------------------
// Admin product management
// ------------------------------
router.post("/admin/items/upload-image", auth, storeImageUpload.single("image"), adminUploadItemImage);
router.post("/admin/items", auth, adminCreateItem);
router.patch("/admin/items/:sku", auth, adminUpdateItem);
router.delete("/admin/items/:sku", auth, adminDeleteItem);

// ------------------------------
// Admin order management
// ------------------------------
router.get("/admin/orders", auth, adminListOrders);
router.patch("/admin/orders/:orderId/status", auth, adminUpdateOrderStatus);

export default router;
