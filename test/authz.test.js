import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlatformAdmin,
  isLegacyAdminLike,
  hasPlatformAdminAccess,
  isAssignableRole,
} from "../src/utils/authz.js";

test("venue_owner is NOT a platform admin (escalation closed)", () => {
  const user = { profile: { role: "VENUE_OWNER", userType: "VENUE_OWNER" } };
  assert.equal(isPlatformAdmin(user), false);
});

test("explicit profile.isPlatformAdmin flag grants admin", () => {
  assert.equal(isPlatformAdmin({ profile: { isPlatformAdmin: true } }), true);
});

test("exact admin role grants admin, substring does not", () => {
  assert.equal(isPlatformAdmin({ profile: { role: "admin" } }), true);
  assert.equal(isPlatformAdmin({ profile: { role: "club_administrator" } }), false);
});

test("ADMIN_EMAILS allow-list grants admin", () => {
  process.env.ADMIN_EMAILS = "boss@example.com, ops@example.com";
  assert.equal(isPlatformAdmin({ email: "BOSS@example.com" }), true);
  assert.equal(isPlatformAdmin({ email: "random@example.com" }), false);
  delete process.env.ADMIN_EMAILS;
});

test("strict mode (default) blocks legacy substring roles", () => {
  delete process.env.AUTHZ_STRICT_ADMIN;
  const user = { profile: { role: "organizer" } };
  assert.equal(isLegacyAdminLike(user), true);
  assert.equal(hasPlatformAdminAccess(user), false);
});

test("AUTHZ_STRICT_ADMIN=false restores legacy behaviour", () => {
  process.env.AUTHZ_STRICT_ADMIN = "false";
  const user = { profile: { role: "organizer" } };
  assert.equal(hasPlatformAdminAccess(user), true);
  delete process.env.AUTHZ_STRICT_ADMIN;
});

test("role assignment allow-list excludes admin roles", () => {
  assert.equal(isAssignableRole("player"), true);
  assert.equal(isAssignableRole("venue_owner"), true);
  assert.equal(isAssignableRole("admin"), false);
  assert.equal(isAssignableRole("super_admin"), false);
});
