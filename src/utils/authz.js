// src/utils/authz.js
//
// Phase 0 — Centralised authorization helpers.
//
// Goal: separate the concept of a *platform admin* (can manage all users,
// clubs, tournaments, payments) from an *organiser / venue owner* (can manage
// only their own club + tournaments).
//
// Historically `adminMiddleware` and `admin.controller.isAdminUser` granted
// admin access to anyone whose role string merely *contained* "admin",
// "organizer", "club" or "venue". Because a normal user becomes a
// VENUE_OWNER the first time they hit `/api/auth/session`, this allowed
// trivial privilege escalation to full platform admin.
//
// This module introduces an explicit platform-admin signal while keeping the
// old behaviour available behind a feature flag for instant rollback. All
// changes are additive and non-destructive.

function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// When true (default), platform-admin access requires an explicit admin signal.
// Set AUTHZ_STRICT_ADMIN=false to restore the legacy substring behaviour.
export function strictAdminEnabled() {
  return envFlag("AUTHZ_STRICT_ADMIN", true);
}

// When true (default), privileged wallet operations (refunds, withdrawal
// settlement) require a platform admin. Set AUTHZ_STRICT_WALLET=false to
// restore the legacy self-service behaviour.
export function strictWalletEnabled() {
  return envFlag("AUTHZ_STRICT_WALLET", true);
}

// Roles that, by themselves, denote a true platform administrator.
const PLATFORM_ADMIN_ROLES = new Set([
  "admin",
  "superadmin",
  "super_admin",
  "platform_admin",
  "platformadmin",
  "root",
]);

// Roles an admin is allowed to assign through the admin API. Deliberately
// excludes platform-admin roles so the role-update endpoint cannot be used to
// mint new admins (privilege creep). Override with ADMIN_ASSIGNABLE_ROLES.
const DEFAULT_ASSIGNABLE_ROLES = [
  "user",
  "player",
  "organizer",
  "organiser",
  "venue_owner",
  "club",
  "club_owner",
];

export function assignableRoles() {
  const raw = cleanString(process.env.ADMIN_ASSIGNABLE_ROLES);
  if (!raw) return [...DEFAULT_ASSIGNABLE_ROLES];
  return raw
    .split(",")
    .map((r) => cleanString(r).toLowerCase())
    .filter(Boolean);
}

export function isAssignableRole(role) {
  return assignableRoles().includes(cleanString(role).toLowerCase());
}

function adminEmailAllowList() {
  const raw = cleanString(process.env.ADMIN_EMAILS);
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => cleanString(e).toLowerCase())
    .filter(Boolean);
}

// All role-ish fields we look at on a user document.
export function rolesOf(user) {
  const candidates = [
    user?.role,
    user?.userType,
    user?.accountType,
    user?.profile?.role,
    user?.profile?.userType,
    user?.profile?.type,
  ];
  return candidates
    .map((c) => cleanString(c).toLowerCase())
    .filter(Boolean);
}

// Primary role string (first non-empty), preserved for compatibility with the
// old roleFromUser/extractRole helpers.
export function primaryRole(user) {
  const roles = rolesOf(user);
  return roles[0] || "";
}

// Explicit, non-substring platform-admin check.
export function isPlatformAdmin(user) {
  if (!user) return false;

  // 1) Explicit boolean flags set deliberately by an operator.
  if (user.isAdmin === true) return true;
  if (user.isPlatformAdmin === true) return true;
  if (user?.profile?.isPlatformAdmin === true) return true;
  if (user?.profile?.isAdmin === true) return true;

  // 2) An exact admin role (not a substring match).
  for (const r of rolesOf(user)) {
    if (PLATFORM_ADMIN_ROLES.has(r)) return true;
  }

  // 3) Email allow-list (operator bootstrap before any flag is set).
  const email = cleanString(user.email).toLowerCase();
  if (email && adminEmailAllowList().includes(email)) return true;

  return false;
}

// Legacy behaviour: role merely *contains* an elevated keyword.
export function isLegacyAdminLike(user) {
  for (const r of rolesOf(user)) {
    if (
      r.includes("admin") ||
      r.includes("organizer") ||
      r.includes("organiser") ||
      r.includes("club") ||
      r.includes("venue")
    ) {
      return true;
    }
  }
  return false;
}

// The effective admin decision, honouring the feature flag.
export function hasPlatformAdminAccess(user) {
  if (isPlatformAdmin(user)) return true;
  if (!strictAdminEnabled()) return isLegacyAdminLike(user);
  return false;
}

export default {
  strictAdminEnabled,
  strictWalletEnabled,
  assignableRoles,
  isAssignableRole,
  rolesOf,
  primaryRole,
  isPlatformAdmin,
  isLegacyAdminLike,
  hasPlatformAdminAccess,
};
