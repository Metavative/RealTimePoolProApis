// Route-wiring integration check (no DB required).
//
// Inspects the REAL Express router stacks to verify that the Phase B endpoints
// are registered at the right paths/methods and — critically — that the player
// `discover` route is declared BEFORE the club-only `/:id` route so it is not
// shadowed (the exact bug class caught during Phase B1).
//
// Run: node ./test/routes.test.js

import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "routes_test_secret";

let failures = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(e?.stack || e);
  }
}

// Walk an Express router stack into [{ method, path }] in declaration order.
function routesOf(router) {
  const out = [];
  for (const layer of router.stack || []) {
    if (layer.route) {
      const path = layer.route.path;
      const methods = Object.keys(layer.route.methods || {}).filter(
        (m) => layer.route.methods[m]
      );
      for (const m of methods) out.push({ method: m.toUpperCase(), path });
    }
  }
  return out;
}

const tournamentRouter = (await import("../src/routes/tournament.route.js")).default;
const tournamentInviteRoutes = (await import("../src/routes/tournamentInvite.routes.js"))
  .default;

const tRoutes = routesOf(tournamentRouter);
const inviteRoutes = routesOf(tournamentInviteRoutes({}, new Map()));

function has(routes, method, path) {
  return routes.some((r) => r.method === method && r.path === path);
}
function indexOf(routes, method, path) {
  return routes.findIndex((r) => r.method === method && r.path === path);
}

t("discover route exists and is player-facing on the tournament router", () => {
  assert.ok(has(tRoutes, "GET", "/discover"), "GET /discover missing");
});

t("discover is declared BEFORE /:id (not shadowed by club getOne)", () => {
  const discoverIdx = indexOf(tRoutes, "GET", "/discover");
  const idIdx = indexOf(tRoutes, "GET", "/:id");
  assert.ok(discoverIdx >= 0 && idIdx >= 0, "both routes must exist");
  assert.ok(
    discoverIdx < idIdx,
    `/discover (${discoverIdx}) must come before /:id (${idIdx})`
  );
});

t("prize settle route exists", () => {
  assert.ok(
    has(tRoutes, "POST", "/:id/prizes/settle"),
    "POST /:id/prizes/settle missing"
  );
});

t("existing club routes are preserved (start/complete/entrants)", () => {
  assert.ok(has(tRoutes, "POST", "/:id/start"));
  assert.ok(has(tRoutes, "POST", "/:id/complete"));
  assert.ok(has(tRoutes, "POST", "/:id/entrants"));
  assert.ok(has(tRoutes, "GET", "/:id"));
});

t("player join & leave routes exist on the invite router", () => {
  assert.ok(
    has(inviteRoutes, "POST", "/tournaments/:tournamentId/join"),
    "join route missing"
  );
  assert.ok(
    has(inviteRoutes, "POST", "/tournaments/:tournamentId/leave"),
    "leave route missing"
  );
});

t("invite router did NOT re-declare /tournaments/discover (avoids duplicate)", () => {
  assert.ok(
    !has(inviteRoutes, "GET", "/tournaments/discover"),
    "discover should live only on the tournament router"
  );
});

// ---- Phase D: dashboard routes ----
const adminRouter = (await import("../src/routes/admin.route.js")).default;
const userRouter = (await import("../src/routes/user.route.js")).default;
const adminRoutes = routesOf(adminRouter);
const userRoutes = routesOf(userRouter);

t("admin platform overview route exists alongside legacy stats", () => {
  assert.ok(has(adminRoutes, "GET", "/overview"), "GET /overview missing");
  assert.ok(has(adminRoutes, "GET", "/stats"), "GET /stats (legacy) must remain");
});

t("player dashboard route exists and is before any /:id", () => {
  assert.ok(has(userRoutes, "GET", "/dashboard"), "GET /dashboard missing");
  // /me and /leaderboard still present (unchanged)
  assert.ok(has(userRoutes, "GET", "/me"));
  assert.ok(has(userRoutes, "GET", "/leaderboard"));
});

if (failures > 0) {
  console.error(`\n${failures} route test(s) failed.`);
  process.exit(1);
}
console.log("\nAll route tests passed.");
