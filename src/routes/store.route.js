import express from "express";
import multer from "multer";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";
import {
  listItems,
  getItem,
  createOrder,
  createCheckoutOrder,
  syncCheckoutOrderPayment,
  cancelCheckoutOrder,
  myOrders,
  adminListItems,
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

// Store data is highly dynamic (stock/orders), so disable intermediary caching.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
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
router.post("/checkout/orders", auth, createCheckoutOrder);
router.post("/checkout/orders/:orderId/sync-payment", auth, syncCheckoutOrderPayment);
router.post("/checkout/orders/:orderId/cancel", auth, cancelCheckoutOrder);

// ------------------------------
// Admin product management
// ------------------------------
router.get("/admin/items", auth, adminListItems);
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
