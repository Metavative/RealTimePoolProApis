# Deploy Checklist

Two independent phases:
- **Phase A** — ship the accumulated code fixes. Safe, no payment go-live. Do now.
- **Phase B** — turn on real card payments. Needs production myPOS credentials.

Repos:
- Backend → `Metavative/RealTimePoolProApis` (branch `main`) → **Railway** auto-deploys.
- App → `Metavative/PoolProFrontEnd` (branch `master`) → rebuild + distribute.

---

## Phase A — Ship the code fixes (no payment go-live)

### A0. Pre-flight (backend)
```
cd BackendPoolPro/RealTimePoolProApis
npm test                     # 14 unit — must pass
node scripts/run-integration.mjs   # 23 integration — must pass (uses isolated test db)
```

### A1. Backend — commit & push
Changed (production-relevant):
- `src/controllers/userController.js`, `src/controllers/insights.controller.js` — exclude platform-admin/system accounts from the leaderboards.
- `src/controllers/payments.controller.js` — sync the `earnings.availableBalance` cache after wallet top-ups/withdrawals (only active when `FEATURE_LEDGER_UNIFIED` is on; safe no-op otherwise).
- `src/config/db.js` — additive `MONGO_DB_NAME` override (unset = unchanged).
- `test/integration.test.js` — new full-lifecycle + 1v1 scope tests.
- `scripts/*` (preflight, seed, admin tooling) + `docs/*` — utilities/docs, inert at runtime.

```
git add -A
git commit -m "Leaderboard admin-exclusion, wallet cache sync, shipping tests + tooling"
git push origin main
```

### A2. Backend — verify on Railway
- Railway redeploys automatically on push (or trigger a redeploy).
- Confirm the service **boots** (no `assertPaymentsSafeForEnv` failure — payments still off, so fine).
- Health check: `GET https://realtimepoolproapis-production.up.railway.app/api/features/v2/status` → 200.
- Spot check: the **leaderboard no longer lists "Administrator"** as a player.

### A3. App — commit & push
Changed:
- `lib/controllers/wallet_controller.dart` — instant top-up row + "Winnings" label.
- `lib/screens/Player-Screen/player_profile_screen.dart` — Total Earnings / Entry Fees / Dispute rows show real values.
- `lib/screens/home/landing_screen.dart` — hide the "enable organizer mode" banner for registered organisers.
- `lib/screens/store/store_cart_screen.dart` — delivery-address step at checkout.

```
cd RealTimePoolPro
flutter analyze          # clean (only pre-existing withOpacity infos)
git add -A
git commit -m "Wallet UX, profile earnings rows, organizer banner, store shipping address"
git push origin master
```

### A4. App — rebuild & distribute
```
flutter build apk --release \
  --dart-define=API_BASE_URL=https://realtimepoolproapis-production.up.railway.app
# (or: flutter build appbundle --release ... for Play Store)
```
- Distribute: Play Store internal track, or sideload the APK.
- Verify on device: profile shows `£0` earnings rows (not blank); the store checkout shows the **delivery-address form**.

**End of Phase A — all fixes live, payments still off.**

---

## Phase B — Payments go-live (needs production myPOS creds)

Full detail in **`docs/MYPOS_GO_LIVE.md`**. Summary:

### B1. Get production myPOS credentials
A live myPOS Online-Payments / Mobile-Checkout store → wallet number, SID, key index, private key (PEM), public cert (PEM). Sandbox creds cannot take real money.

### B2. Set Railway env (backend)
```
FEATURE_PAYMENTS_V2=true
PAYMENTS_PROVIDER=MYPOS
PAYMENTS_ENVIRONMENT=PRODUCTION
MYPOS_ENVIRONMENT=PRODUCTION
MYPOS_WALLET_NUMBER=<live>   MYPOS_SID=<live>   MYPOS_KEY_INDEX=<live>
MYPOS_PRIVATE_KEY=<live PEM, single line with \n>
MYPOS_PUBLIC_CERT=<live PEM, single line with \n>
MYPOS_MOBILE_CURRENCY=GBP            # must equal the store currency
MYPOS_REQUIRE_TXN_REF=true
MYPOS_RETURN_BASE_URL=https://realtimepoolproapis-production.up.railway.app
# Optional money features:
FEATURE_TOURNAMENT_ECONOMY_V2=true   FEATURE_TOURNAMENT_REFUNDS=true
FEATURE_ORGANIZER_PAYOUTS=true       FEATURE_LEDGER_UNIFIED=true   # activates the wallet cache-sync fix
```

### B3. Validate + test
```
node scripts/mypos-preflight.mjs     # must report 0 blocking (with prod values loaded)
```
- Do one **small real payment on a real Android device** (native card screen). Confirm wallet credits + `PaymentIntent` PAID with a gateway reference.

### B4. Rollback
Set `FEATURE_PAYMENTS_V2=false` — the app degrades gracefully (wallet/entry actions disable themselves).

---

## Housekeeping (independent of A/B)
- **Remove the £5 test top-up** from prod: `node scripts/cleanup-test-wallet.mjs 6a42561085d08965c559e006` (writes to prod — deliberate).
- **Rotate shared secrets** before public launch: the hardcoded admin login (`admin@poolpro.app`), Cloudinary API secret.
- **Confirm Railway `MONGO_URI`** points at the current `cluster0.htldn01` Atlas cluster (per the DB-migration note).
- **Tear down** the local demo backend + `poolpro_demo` db when done; restore the release build on the emulator.

---

## iOS (separate track)
When the Apple myPOS SDK is provided, build the iOS native bridge (same `pool_pro/mypos` MethodChannel contract) so `MyposMobileService.isSupported` includes iOS, then `flutter build ipa` + App Store release.
