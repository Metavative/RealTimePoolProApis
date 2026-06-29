import express from "express";
import { adminMiddleware } from "../middleware/adminMiddleware.js";

import {
  me,
  dashboardStats,
  platformOverview,
  walletReconciliation,
  disputeTrends,

  listUsers,
  getUser,
  updateUserRole,
  setUserActive,

  listStoreItems,
  getStoreItem,
  createStoreItem,
  updateStoreItem,
  disableStoreItem,

  listOrders,
  getOrder,
  updateOrderStatus,

  listTournaments,
  getTournament,
  updateTournamentStatus,
  listClubs,
  updateClubStatus,
} from "../controllers/admin.controller.js";

import {
  adminListPayouts,
  adminCompletePayout,
  adminFailPayout,
} from "../controllers/payments.controller.js";

const router = express.Router();

// ------------------------------
// Admin session
// ------------------------------
router.get("/me", adminMiddleware, me);

// ------------------------------
// Dashboard stats
// ------------------------------
router.get("/stats", adminMiddleware, dashboardStats);
router.get("/overview", adminMiddleware, platformOverview);
router.get("/wallet-reconciliation", adminMiddleware, walletReconciliation);
router.get("/dispute-trends", adminMiddleware, disputeTrends);

// ------------------------------
// Users
// ------------------------------
router.get("/users", adminMiddleware, listUsers);
router.get("/users/:userId", adminMiddleware, getUser);
router.patch("/users/:userId/role", adminMiddleware, updateUserRole);
router.patch("/users/:userId/active", adminMiddleware, setUserActive);

// ------------------------------
// Store management
// ------------------------------
router.get("/store/items", adminMiddleware, listStoreItems);
router.get("/store/items/:sku", adminMiddleware, getStoreItem);
router.post("/store/items", adminMiddleware, createStoreItem);
router.patch("/store/items/:sku", adminMiddleware, updateStoreItem);
router.delete("/store/items/:sku", adminMiddleware, disableStoreItem);

// ------------------------------
// Orders
// ------------------------------
router.get("/orders", adminMiddleware, listOrders);
router.get("/orders/:orderId", adminMiddleware, getOrder);
router.patch("/orders/:orderId/status", adminMiddleware, updateOrderStatus);

// ------------------------------
// Tournaments
// ------------------------------
router.get("/tournaments", adminMiddleware, listTournaments);
router.get("/tournaments/:tournamentId", adminMiddleware, getTournament);
router.patch(
  "/tournaments/:tournamentId/status",
  adminMiddleware,
  updateTournamentStatus
);

// ------------------------------
// Clubs / Organizer verification
// ------------------------------
router.get("/clubs", adminMiddleware, listClubs);
router.patch("/clubs/:clubId/status", adminMiddleware, updateClubStatus);

// ------------------------------
// Payout settlement (player withdrawals + organiser payouts)
// ------------------------------
router.get("/payouts", adminMiddleware, adminListPayouts);
router.post("/payouts/:payoutId/complete", adminMiddleware, adminCompletePayout);
router.post("/payouts/:payoutId/fail", adminMiddleware, adminFailPayout);

export default router;
