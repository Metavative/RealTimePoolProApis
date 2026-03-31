import express from "express";
import { authMiddleware as auth } from "../middleware/authMiddleware.js";
import {
  v2Status,
  createPaymentIntent,
  myPaymentIntents,
  getPaymentIntent,
  applyIntentLedgerRules,
  getIntentLedgerDetails,
  createCheckoutSession,
  refreshPaymentIntent,
  cancelPaymentIntent,
  confirmPaymentIntent,
  createWalletTopupIntent,
  settleWalletTopup,
  createWalletHold,
  myWalletHolds,
  captureWalletHold,
  releaseWalletHold,
  createWalletRefund,
  requestWalletWithdrawal,
  completeWalletWithdrawal,
  failWalletWithdrawal,
  requestPayout,
  myPayouts,
  myLedgerEntries,
  myLedgerSummary,
  ingestWebhookEvent,
} from "../controllers/payments.controller.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

// Public contracts
router.get("/status", v2Status);
router.post("/webhooks/:provider", ingestWebhookEvent);

// Auth contracts
router.post("/intents", auth, createPaymentIntent);
router.get("/intents/me", auth, myPaymentIntents);
router.get("/intents/:intentId", auth, getPaymentIntent);
router.post("/intents/:intentId/ledger/apply", auth, applyIntentLedgerRules);
router.get("/intents/:intentId/ledger", auth, getIntentLedgerDetails);
router.post("/intents/:intentId/checkout-session", auth, createCheckoutSession);
router.post("/intents/:intentId/refresh", auth, refreshPaymentIntent);
router.post("/intents/:intentId/cancel", auth, cancelPaymentIntent);
router.post("/intents/:intentId/confirm", auth, confirmPaymentIntent);

// Wallet lifecycle
router.post("/wallet/topups/intents", auth, createWalletTopupIntent);
router.post("/wallet/topups/:intentId/settle", auth, settleWalletTopup);
router.post("/wallet/holds", auth, createWalletHold);
router.get("/wallet/holds/me", auth, myWalletHolds);
router.post("/wallet/holds/:holdId/capture", auth, captureWalletHold);
router.post("/wallet/holds/:holdId/release", auth, releaseWalletHold);
router.post("/wallet/refunds", auth, createWalletRefund);
router.post("/wallet/withdrawals", auth, requestWalletWithdrawal);
router.get("/wallet/withdrawals/me", auth, myPayouts);
router.post("/wallet/withdrawals/:payoutId/complete", auth, completeWalletWithdrawal);
router.post("/wallet/withdrawals/:payoutId/fail", auth, failWalletWithdrawal);

router.get("/ledger/me/entries", auth, myLedgerEntries);
router.get("/ledger/me/summary", auth, myLedgerSummary);
router.post("/payouts", auth, requestPayout);
router.get("/payouts/me", auth, myPayouts);

export default router;
