# Pinned Remaining Scope (Client Approved)

Last updated: 2026-03-31
Owner: Product + Engineering
Policy: Additive changes only. Do not break existing app flow.

## Scope Lock
- Excluded by client: `8, 10, 11, 12, 16, 17, 18, 19`
- Payment provider credentials are pending; integration will be prepared in a provider-agnostic way and activated later.

## Ground Rules (Non-Breaking)
- Keep existing APIs, screens, and user journeys working as-is.
- Add all new finance/payment work under versioned endpoints (no hard replacement).
- Use feature flags before enabling new payment flows in production.
- No destructive schema changes or silent behavior changes.

## Remaining Modules (Pinned)
- [x] 1. Real Payment Gateway Module (myPOS-ready abstraction)
- [x] 2. Wallet Funding and Withdrawal Module
- [x] 3. Unified Financial Ledger Module
- [x] 4. Level Economy Engine Module
- [x] 5. Automated Matchmaking Module
- [x] 6. Referral Commission Module
- [x] 7. Tournament Economy Module
- [x] 8. Dispute Case Management Module
- [x] 9. Cups, Prizes, and Achievement History Module
- [x] 10. Organizer Revenue Dashboard Module
- [x] 11. Advanced Leaderboards Module
- [x] 12. Production Reliability Module

## Execution Order (Pinned)
- [x] Step 1. Finance foundation scaffold (models + route contracts + safe toggles)
- [x] Step 2. Payment intent + checkout session lifecycle (provider-neutral)
- [x] Step 3. Webhook event ingestion + idempotency controls
- [x] Step 4. Wallet top-up, hold, capture, refund, withdrawal flows
- [x] Step 5. Ledger posting rules for all economic events
- [x] Step 6. Shop payment migration to new payment lifecycle
- [x] Step 7. Level progression, stake doubling, and settlement enforcement
- [x] Step 8. Matchmaking automation by level, location, and availability
- [x] Step 9. Tournament/league fee distribution + organizer share
- [x] Step 10. Referral commission posting and history
- [x] Step 11. Dispute workflow with payout impact rules
- [x] Step 12. Achievements, dashboards, leaderboards, and reliability hardening

## myPOS Credentials Needed Later (When Available)
- Partner Client ID (`client_*`)
- Partner Secret (`secret_*`)
- Merchant Client ID (`cli_*`)
- Merchant Secret (`sec_*`)
- Partner ID (`mps-p-*`)
- Application ID (`mps-app-*`)
- Webhook URL (sandbox + production)
- Redirect URLs (success/cancel/failure)
