# myPOS Go-Live Runbook

Everything on the app/server side is built, tested, and proven. This is the
checklist to turn on **real** card payments in production. Nothing here changes
code — it's configuration + verification.

**Status at time of writing**
- 14/14 unit + 21/21 integration tests pass (full money loop).
- Native Android card flow (wallet top-ups + paid tournament entries) tested
  end-to-end against the myPOS sandbox — a real sandbox card was accepted and the
  wallet credited.
- Refund-to-wallet and provider refund paths implemented and tested.
- Config is validated by `scripts/mypos-preflight.mjs`.

---

## The one hard requirement: PRODUCTION credentials

The credentials currently in the local `.env` are **sandbox** (`MYPOS_ENVIRONMENT=TEST`).
Sandbox can demo the entire flow but **cannot charge a real card**.

To take real money you need a **myPOS production Online-Payments / Mobile-Checkout
store** and its live values:
- `MYPOS_WALLET_NUMBER`
- `MYPOS_SID`
- `MYPOS_KEY_INDEX`
- `MYPOS_PRIVATE_KEY` (merchant RSA private key, PEM)
- `MYPOS_PUBLIC_CERT` (myPOS public certificate, PEM)

> PEMs must be stored as a single line with literal `\n` escapes (the provider
> un-escapes them). Multi-line values break `dotenv`.

---

## Step 1 — Set production env on Railway (backend service)

```
FEATURE_PAYMENTS_V2=true
PAYMENTS_PROVIDER=MYPOS
PAYMENTS_ENVIRONMENT=PRODUCTION
MYPOS_ENVIRONMENT=PRODUCTION

MYPOS_WALLET_NUMBER=<live>
MYPOS_SID=<live>
MYPOS_KEY_INDEX=<live>
MYPOS_PRIVATE_KEY=<live PEM, single line with \n>
MYPOS_PUBLIC_CERT=<live PEM, single line with \n>

# MUST equal your myPOS store currency (and the app wallet currency)
MYPOS_MOBILE_CURRENCY=GBP

# Keep on: requires a real gateway reference before settling a charge
MYPOS_REQUIRE_TXN_REF=true

# Public https origin myPOS redirects/notifies back to (no port)
MYPOS_RETURN_BASE_URL=https://realtimepoolproapis-production.up.railway.app
```

Optional money features (leave OFF unless you want them):
```
FEATURE_TOURNAMENT_ECONOMY_V2=true   # enables paid tournament entries
FEATURE_TOURNAMENT_REFUNDS=true      # organiser can refund an entry -> player wallet
FEATURE_ORGANIZER_PAYOUTS=true       # organisers can cash out their balance
# FEATURE_PROVIDER_REFUNDS=true      # ONLY if your myPOS account supports card refunds (see §6)
```

### The boot guard
The server refuses to start if it detects production + payments-on + the MOCK
provider (`assertPaymentsSafeForEnv`). Using `PAYMENTS_PROVIDER=MYPOS` satisfies
it. If the server won't boot, re-check that variable.

---

## Step 2 — Preflight (before and after setting the vars)

Run the read-only validator with the production values loaded:

```
node scripts/mypos-preflight.mjs
```

It must report **0 blocking**. It specifically catches the #1 go-live trap —
`NODE_ENV=production` while `MYPOS_ENVIRONMENT` is still `TEST` (real cards would
be declined by the sandbox gateway).

---

## Step 3 — Currency alignment

`MYPOS_MOBILE_CURRENCY` **must equal** the currency your myPOS store is set to.
Wallet top-up intents are forced to this currency when the provider is MYPOS, so
the intent can't diverge from what's charged. If the store is GBP, keep `GBP`.

---

## Step 4 — Rebuild the mobile app pointing at production

The release APK already targets the production API. If rebuilding:

```
flutter build apk --release --dart-define=API_BASE_URL=https://realtimepoolproapis-production.up.railway.app
```

Payments UI (Add funds / Enter paid tournament) appears only when the backend
reports payments enabled, so it "lights up" automatically once Step 1 is done.

---

## Step 5 — First live payment test (small amount, real device)

1. Install the release APK on a real **Android** device (the native myPOS card
   screen does not run reliably on the memory-starved emulator).
2. Add funds with the smallest allowed amount.
3. Confirm: native myPOS card screen renders → pay with a real card → app shows
   the balance increased and a "Top-up" transaction.
4. Server check: the `PaymentIntent` is `PAID` with a non-empty
   `providerReference`, and the `USER_WALLET` ledger increased by the amount.

If anything fails, nothing is credited — an unverifiable "success" returns 422
and leaves the intent unpaid.

---

## Step 6 — Refunds

Two independent refund mechanisms exist; pick per your myPOS account:

- **Refund to wallet (works today, no myPOS dependency).** Organiser refunds a
  player's paid entry before start → the internal ledger reverses and the money
  returns to the player's **app wallet**. Gated by `FEATURE_TOURNAMENT_REFUNDS`.
  This is the complete refund story for a wallet-based model.

- **Refund to card (IPCRefund, needs account support).** `FEATURE_PROVIDER_REFUNDS=true`
  makes a refund also return money to the original **card** via the myPOS gateway.
  This requires your myPOS account/product to support server-to-server IPCRefund.
  Because the sandbox account we tested is provisioned for the Mobile SDK product,
  confirm with myPOS that card refunds are enabled for your **production** store
  before turning this flag on. If it isn't supported, leave it off and rely on
  wallet refunds + admin withdrawals.

---

## Known limitation (hardening item, not a blocker)

The myPOS Mobile SDK signs and charges the card **on the device** and returns a
transaction reference. Its transaction-status endpoint URL is obfuscated inside
the SDK, so the backend currently trusts the device-reported success **plus** a
required gateway reference and a replay guard (`verifyMyposMobileTransaction`).

For maximum assurance on large amounts, ask **myPOS support** for the mobile
transaction-status endpoint (`IPCIAGetTxnStatus`). When you have it, it drops into
one clearly-marked function (`verifyMyposMobileTransaction` in
`payments.controller.js`) to add a fully independent server-side check. Everything
else stays the same.

---

## Rollback

Set `FEATURE_PAYMENTS_V2=false` (or `PAYMENTS_PROVIDER=MOCK` in a non-prod env).
The app degrades gracefully — wallet/entry payment actions disable themselves and
show an "unavailable" notice. No data is lost.

---

## Cleanup owed

- A **£5 sandbox test top-up** remains in the production wallet/ledger from an
  earlier test. Remove it with `scripts/cleanup-mypos-test.mjs` (writes to prod —
  run deliberately, with approval).
- Delete local sandbox key material from `Downloads` and regenerate the sandbox
  key after go-live.
