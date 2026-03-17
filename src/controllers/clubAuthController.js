// src/controllers/clubAuthController.js
import Club from "../models/club.model.js";
import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail } from "../services/OTPService.js";
import twilio from "twilio";

// =======================================
// Twilio Verify setup (HARD-CODE SERVICE)
// =======================================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const DEFAULT_TWILIO_VERIFY_SERVICE_SID = "VA5340451db0245afdf3c1515254edf2cf";
const TWILIO_VERIFY_SERVICE_SID = (
  process.env.TWILIO_VERIFY_SERVICE_SID ||
  DEFAULT_TWILIO_VERIFY_SERVICE_SID
).trim();

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function assertTwilioConfigured() {
  if (!twilioClient) {
    const err = new Error(
      "Twilio is not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)"
    );
    err.statusCode = 500;
    throw err;
  }
  if (!TWILIO_VERIFY_SERVICE_SID) {
    const err = new Error("Twilio Verify Service SID is missing (set TWILIO_VERIFY_SERVICE_SID)");
    err.statusCode = 500;
    throw err;
  }
}

function isValidE164(phone) {
  return typeof phone === "string" && /^\+\d{8,15}$/.test(phone);
}

async function twilioSendVerifySms(toPhone) {
  assertTwilioConfigured();
  await twilioClient.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({
      to: toPhone,
      channel: "sms",
    });
}

async function twilioCheckVerifyCode(toPhone, code) {
  assertTwilioConfigured();
  const verificationCheck = await twilioClient.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({ to: toPhone, code });

  return verificationCheck?.status === "approved";
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeEmail(email) {
  const v = toStr(email);
  if (!v) return undefined;
  return v.toLowerCase();
}

function normalizePhone(phone) {
  const v = toStr(phone);
  if (!v) return undefined;
  return v;
}

function isEmailIdentifier(identifier) {
  return typeof identifier === "string" && identifier.includes("@");
}

function otpToString(value) {
  return toStr(value);
}

function getBody(req) {
  if (req.body?.data && typeof req.body.data === "object") return req.body.data;
  return req.body || {};
}

function pickEmailOrPhone(body) {
  const emailOrPhone = toStr(body.emailOrPhone);
  if (emailOrPhone) {
    if (isEmailIdentifier(emailOrPhone)) return { email: normalizeEmail(emailOrPhone) };
    return { phone: normalizePhone(emailOrPhone) };
  }

  const identifier = toStr(body.identifier);
  if (identifier) {
    if (isEmailIdentifier(identifier)) return { email: normalizeEmail(identifier) };
    return { phone: normalizePhone(identifier) };
  }

  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);

  if (email) return { email };
  if (phone) return { phone };
  return {};
}

function pickOwnerUserId(body) {
  const v =
    toStr(body.ownerUserId) ||
    toStr(body.ownerId) ||
    toStr(body.userId) ||
    toStr(body.organizerUserId);

  return v || undefined;
}

async function resolveOwnerUserIdOrThrow(ownerUserId) {
  if (!ownerUserId) return undefined;
  const u = await User.findById(ownerUserId).select("_id").lean();
  if (!u) {
    const err = new Error("Invalid ownerUserId (User not found)");
    err.statusCode = 400;
    throw err;
  }
  return u._id;
}

function safeClub(club) {
  if (!club) return null;
  const obj = club.toObject ? club.toObject() : { ...club };
  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;
  return obj;
}

function safeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.passwordHash;
  delete obj.otp;
  return {
    _id: obj._id,
    email: obj.email || null,
    phone: obj.phone || null,
    username: obj.username || null,
    profile: obj.profile || {},
    stats: obj.stats || {},
  };
}

function getPasswordFromClub(club) {
  return club?.passwordHash || club?.password || "";
}

function setPasswordOnClub(club, hash) {
  club.passwordHash = hash;
  club.password = hash;
}

function clubToken(club, ownerUserId) {
  return sign({
    id: String(club._id),
    role: "CLUB",
    typ: "club_access",
    ownerUserId: ownerUserId ? String(ownerUserId) : undefined,
    canPlay: true,
    canManageVenue: true,
  });
}

function isRateLimited(lastOtpSent, windowMs = 60_000) {
  if (!lastOtpSent) return false;
  const now = Date.now();
  const last = new Date(lastOtpSent).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < windowMs;
}

function makeUsernameBase({ club, email, phone }) {
  const fromName = toStr(club?.name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (fromName && fromName.length >= 3) return fromName.slice(0, 20);

  const fromEmail = toStr(email).split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (fromEmail && fromEmail.length >= 3) return fromEmail.slice(0, 20);

  const digits = toStr(phone).replace(/\D/g, "");
  if (digits.length >= 3) return `venue_${digits.slice(-8)}`.slice(0, 20);

  return `venue_${String(club?._id || "").slice(-6)}`.slice(0, 20);
}

async function generateUniqueUsername(baseInput) {
  let base = toStr(baseInput)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!base || base.length < 3) base = "venue_player";
  if (base.length > 20) base = base.slice(0, 20);

  let candidate = base;
  let i = 0;

  while (true) {
    const exists = await User.exists({ usernameLower: candidate.toLowerCase() });
    if (!exists) return candidate;

    i += 1;
    const suffix = `_${i}`;
    const trimmed = base.slice(0, Math.max(3, 20 - suffix.length));
    candidate = `${trimmed}${suffix}`;
  }
}

async function ensureClubOwnerUser(club, explicitOwnerUserId) {
  if (!club) return null;

  // 1) explicit owner passed from request
  if (explicitOwnerUserId) {
    if (!club.owner || String(club.owner) !== String(explicitOwnerUserId)) {
      club.owner = explicitOwnerUserId;
      await club.save();
    }

    const ownerUser = await User.findById(explicitOwnerUserId).select({ passwordHash: 0, otp: 0 });
    if (ownerUser) {
      let changed = false;

      ownerUser.profile = ownerUser.profile || {};
      ownerUser.profile.role = ownerUser.profile.role || "VENUE_OWNER";
      ownerUser.profile.userType = ownerUser.profile.userType || "VENUE_OWNER";
      ownerUser.profile.organizer = {
        ...(ownerUser.profile.organizer || {}),
        clubId: club._id,
        clubName: club.name || "",
      };

      if (!ownerUser.email && club.email) {
        ownerUser.email = club.email;
        changed = true;
      }
      if (!ownerUser.phone && club.phone) {
        ownerUser.phone = club.phone;
        changed = true;
      }
      if (!ownerUser.profile.nickname && club.name) {
        ownerUser.profile.nickname = club.name;
        changed = true;
      }

      if (changed) await ownerUser.save();
      return ownerUser;
    }
  }

  // 2) already linked
  if (club.owner) {
    const existingOwner = await User.findById(club.owner).select({ passwordHash: 0, otp: 0 });
    if (existingOwner) {
      let changed = false;

      existingOwner.profile = existingOwner.profile || {};
      if (!existingOwner.profile.role) {
        existingOwner.profile.role = "VENUE_OWNER";
        changed = true;
      }
      if (!existingOwner.profile.userType) {
        existingOwner.profile.userType = "VENUE_OWNER";
        changed = true;
      }

      existingOwner.profile.organizer = {
        ...(existingOwner.profile.organizer || {}),
        clubId: club._id,
        clubName: club.name || "",
      };

      if (!existingOwner.email && club.email) {
        existingOwner.email = club.email;
        changed = true;
      }
      if (!existingOwner.phone && club.phone) {
        existingOwner.phone = club.phone;
        changed = true;
      }
      if (!existingOwner.profile.nickname && club.name) {
        existingOwner.profile.nickname = club.name;
        changed = true;
      }

      if (changed) await existingOwner.save();
      return existingOwner;
    }
  }

  // 3) try to find an existing User by email/phone
  let matchedUser = null;

  if (club.email) {
    matchedUser = await User.findOne({ email: club.email }).select({ passwordHash: 0, otp: 0 });
  }
  if (!matchedUser && club.phone) {
    matchedUser = await User.findOne({ phone: club.phone }).select({ passwordHash: 0, otp: 0 });
  }

  if (matchedUser) {
    club.owner = matchedUser._id;
    await club.save();

    matchedUser.profile = matchedUser.profile || {};
    matchedUser.profile.role = matchedUser.profile.role || "VENUE_OWNER";
    matchedUser.profile.userType = matchedUser.profile.userType || "VENUE_OWNER";
    matchedUser.profile.organizer = {
      ...(matchedUser.profile.organizer || {}),
      clubId: club._id,
      clubName: club.name || "",
    };

    if (!matchedUser.profile.nickname && club.name) {
      matchedUser.profile.nickname = club.name;
    }

    await matchedUser.save();
    return matchedUser;
  }

  // 4) create a new shadow player user for the venue owner
  const usernameBase = makeUsernameBase({
    club,
    email: club.email,
    phone: club.phone,
  });
  const username = await generateUniqueUsername(usernameBase);

  const newUser = await User.create({
    ...(club.email ? { email: club.email } : {}),
    ...(club.phone ? { phone: club.phone } : {}),
    emailVerified: !!club.emailVerified,
    phoneVerified: !!club.phoneVerified,
    username,
    profile: {
      nickname: club.name || username,
      role: "VENUE_OWNER",
      userType: "VENUE_OWNER",
      verified: !!club.verified,
      organizer: {
        clubId: club._id,
        clubName: club.name || "",
      },
    },
  });

  club.owner = newUser._id;
  await club.save();

  return User.findById(newUser._id).select({ passwordHash: 0, otp: 0 });
}

async function attachVenuePlayer(club, ownerUserId) {
  const ownerUser = await ensureClubOwnerUser(club, ownerUserId);
  const token = clubToken(club, ownerUser?._id);

  return {
    club: safeClub(club),
    ownerUser: safeUser(ownerUser),
    token,
    capabilities: {
      canManageVenue: true,
      canPlay: true,
    },
  };
}

function defaultClubNameFromUser(user) {
  const profile =
    user?.profile && typeof user.profile === "object" ? user.profile : {};

  const nickname = toStr(profile.nickname);
  if (nickname) return nickname;

  const firstName = toStr(profile.firstName);
  const lastName = toStr(profile.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;

  const username = toStr(user?.username);
  if (username) return username;

  return "Organizer";
}

async function createClubForUser(user) {
  const ownerId = toStr(user?._id);
  if (!ownerId) throw new Error("Cannot create organizer profile without user id");

  const email = normalizeEmail(user?.email);
  const phone = normalizePhone(user?.phone);

  try {
    return await Club.create({
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      owner: user._id,
      name: defaultClubNameFromUser(user),
      status: "PENDING_REVIEW",
      verified: false,
      emailVerified: !!user?.emailVerified,
      phoneVerified: !!user?.phoneVerified,
      capabilities: {
        canManageVenue: true,
        canPlay: true,
      },
    });
  } catch (e) {
    if (e?.code !== 11000) throw e;

    const queryOr = [
      { owner: user._id },
      email ? { email } : null,
      phone ? { phone } : null,
    ].filter(Boolean);

    const existing = queryOr.length
      ? await Club.findOne({ $or: queryOr })
      : await Club.findOne({ owner: user._id });

    if (existing) return existing;
    throw e;
  }
}

// =============================
// CLUB SESSION FROM USER TOKEN
// =============================
export async function clubSessionFromUser(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const userId = toStr(req?.userId || req?.user?._id);
    if (!userId) {
      return res.status(401).json({ message: "User authorization required" });
    }

    const authUser =
      req.user ||
      (await User.findById(userId).select({ passwordHash: 0, otp: 0 }));

    if (!authUser) {
      return res.status(401).json({ message: "User not found" });
    }

    let club = await Club.findOne({ owner: authUser._id });

    if (!club && authUser.email) {
      club = await Club.findOne({ email: normalizeEmail(authUser.email) });
    }

    if (!club && authUser.phone) {
      club = await Club.findOne({ phone: normalizePhone(authUser.phone) });
    }

    let wasProvisioned = false;
    if (!club) {
      club = await createClubForUser(authUser);
      wasProvisioned = true;
    }

    const status = String(club.status || "").toUpperCase().trim();
    if (status === "SUSPENDED") {
      return res.status(403).json({
        code: "CLUB_SUSPENDED",
        message: "Organizer access is currently suspended for this account.",
      });
    }

    const response = await attachVenuePlayer(club, authUser._id);
    return res.json({
      ok: true,
      provisioned: wasProvisioned,
      ...response,
    });
  } catch (error) {
    console.error("[CLUB_AUTH][SESSION_FROM_USER][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// CLUB SIGNUP (password)
// =============================
export async function clubSignUp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const password = toStr(body.password);

    const name = toStr(body.name);
    const address = toStr(body.address);

    const ownerUserIdRaw = pickOwnerUserId(body);
    const ownerUserId = await resolveOwnerUserIdOrThrow(ownerUserIdRaw);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    if (phone && !isValidE164(phone)) {
      return res
        .status(400)
        .json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);
    const existing = await Club.findOne({ $or: queryOr }).select("+passwordHash +password");
    if (existing) {
      return res.status(409).json({ message: "Club already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const club = await Club.create({
      email,
      phone,
      passwordHash: hash,
      password: hash,
      name,
      address,
      ...(ownerUserId ? { owner: ownerUserId } : {}),
      status: "PENDING_VERIFICATION",
      verified: false,
      emailVerified: false,
      phoneVerified: false,
      lastOtpSent: null,
      lastOtpChannel: null,
    });

    const response = await attachVenuePlayer(club, ownerUserId);
    return res.json(response);
  } catch (error) {
    console.error("[CLUB_AUTH][SIGNUP][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });

    if (error && error.code === 11000) {
      return res.status(409).json({ message: "Club already exists" });
    }

    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// CLUB LOGIN (password)
// =============================
export async function clubLogin(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const password = toStr(body.password);
    if (!password) return res.status(400).json({ message: "Password required" });

    const lookup = pickEmailOrPhone(body);
    if (!lookup.email && !lookup.phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    const club = await Club.findOne(lookup).select("+passwordHash +password");
    if (!club) return res.status(404).json({ message: "Club not found" });

    const stored = getPasswordFromClub(club);
    if (!stored) return res.status(400).json({ message: "No local password set" });

    const ok = await bcrypt.compare(password, stored);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const ownerUserIdRaw = pickOwnerUserId(body);
    const ownerUserId = await resolveOwnerUserIdOrThrow(ownerUserIdRaw);

    const response = await attachVenuePlayer(club, ownerUserId);
    return res.json(response);
  } catch (error) {
    console.error("[CLUB_AUTH][LOGIN][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}

// =======================================================
// SIGNUP OTP REQUEST (send to BOTH email + phone)
// =======================================================
export async function clubRequestSignupOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const email =
      normalizeEmail(body.email) ||
      (isEmailIdentifier(toStr(body.identifier)) ? normalizeEmail(body.identifier) : undefined);

    const phone =
      normalizePhone(body.phone) ||
      (!isEmailIdentifier(toStr(body.identifier)) ? normalizePhone(body.identifier) : undefined);

    const ownerUserIdRaw = pickOwnerUserId(body);
    const ownerUserId = await resolveOwnerUserIdOrThrow(ownerUserIdRaw);

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    if (phone && !isValidE164(phone)) {
      return res
        .status(400)
        .json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);

    let club = await Club.findOne({ $or: queryOr });

    if (!club) {
      club = await Club.create({
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(ownerUserId ? { owner: ownerUserId } : {}),
        status: "PENDING_VERIFICATION",
        verified: false,
        emailVerified: false,
        phoneVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
      });
    }

    await ensureClubOwnerUser(club, ownerUserId);

    if (isRateLimited(club.lastOtpSent, 60_000)) {
      return res
        .status(429)
        .json({ message: "Please wait 60 seconds before requesting another code." });
    }

    club.lastOtpSent = new Date();
    club.lastOtpChannel = "multi";

    const channelsSent = [];

    if (club.email) {
      const code = otpToString(generateOtp(6));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      club.otp = { code, expiresAt };
      await club.save();

      await sendOtpEmail(club.email, code);
      channelsSent.push("email");
    } else {
      club.otp = undefined;
      await club.save();
    }

    if (club.phone) {
      if (!isValidE164(club.phone)) {
        return res
          .status(400)
          .json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
      }
      await twilioSendVerifySms(club.phone);
      channelsSent.push("phone");
    }

    return res.json({
      ok: true,
      message: "Signup OTP sent",
      flow: "signup",
      target: {
        ...(club.email ? { email: club.email } : {}),
        ...(club.phone ? { phone: club.phone } : {}),
      },
      channelsSent,
      capabilities: {
        canManageVenue: true,
        canPlay: true,
      },
    });
  } catch (error) {
    console.error("[CLUB_OTP][SIGNUP_REQUEST][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// OTP REQUEST: login (single-channel)
// =============================
export async function clubRequestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;
    const flow = toStr(body.flow) || "login";

    const ownerUserIdRaw = pickOwnerUserId(body);
    const ownerUserId = await resolveOwnerUserIdOrThrow(ownerUserIdRaw);

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone") {
      if (!isValidE164(phone)) {
        return res
          .status(400)
          .json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
      }
      assertTwilioConfigured();
    }

    let club = await Club.findOne(query);

    if (flow === "login" && !club) {
      return res.status(404).json({ message: "Club not found. Please sign up." });
    }

    if (!club) {
      club = await Club.create({
        ...query,
        ...(ownerUserId ? { owner: ownerUserId } : {}),
        status: "PENDING_VERIFICATION",
        verified: false,
        emailVerified: false,
        phoneVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
      });
    }

    await ensureClubOwnerUser(club, ownerUserId);

    if (isRateLimited(club.lastOtpSent, 60_000)) {
      return res
        .status(429)
        .json({ message: "Please wait 60 seconds before requesting another code." });
    }

    club.lastOtpSent = new Date();
    club.lastOtpChannel = channel;

    if (channel === "email") {
      const code = otpToString(generateOtp(6));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      club.otp = { code, expiresAt };
      await club.save();

      await sendOtpEmail(email, code);

      return res.json({
        ok: true,
        message: "OTP sent",
        channel: "email",
        target: email,
        flow,
        capabilities: {
          canManageVenue: true,
          canPlay: true,
        },
      });
    }

    club.otp = undefined;
    await club.save();

    await twilioSendVerifySms(phone);

    return res.json({
      ok: true,
      message: "OTP sent",
      channel: "phone",
      target: phone,
      flow,
      capabilities: {
        canManageVenue: true,
        canPlay: true,
      },
    });
  } catch (error) {
    console.error("[CLUB_OTP][REQUEST][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// OTP VERIFY
// =============================
export async function clubVerifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;
    const flow = toStr(body.flow) || "login";
    const code = otpToString(body.code || body.otp);

    const ownerUserIdRaw = pickOwnerUserId(body);
    const ownerUserId = await resolveOwnerUserIdOrThrow(ownerUserIdRaw);

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });
    if (!code) return res.status(400).json({ message: "OTP required" });

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone") {
      if (!isValidE164(phone)) {
        return res
          .status(400)
          .json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
      }
      assertTwilioConfigured();
    }

    const club = await Club.findOne(query);
    if (!club) return res.status(404).json({ message: "Club not found" });

    if (channel === "email") {
      if (!club.otp || !club.otp.code) {
        return res.status(404).json({ message: "OTP not found" });
      }

      if (club.otp.expiresAt && club.otp.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ message: "OTP expired" });
      }

      if (otpToString(club.otp.code) !== code) {
        return res.status(400).json({ message: "Invalid OTP" });
      }

      club.otp = undefined;
      club.emailVerified = true;
      club.lastOtpSent = null;
      club.lastOtpChannel = null;
      await club.save();
    } else {
      const ok = await twilioCheckVerifyCode(phone, code);
      if (!ok) return res.status(400).json({ message: "Invalid OTP" });

      club.phoneVerified = true;
      club.lastOtpSent = null;
      club.lastOtpChannel = null;
      await club.save();
    }

    if (flow === "signup") {
      club.verified = true;
      if (club.status === "PENDING_VERIFICATION") {
        club.status = "ACTIVE";
      }
      await club.save();
    }

    const ownerUser = await ensureClubOwnerUser(club, ownerUserId);

    if (ownerUser) {
      let changed = false;

      if (club.emailVerified && !ownerUser.emailVerified) {
        ownerUser.emailVerified = true;
        changed = true;
      }
      if (club.phoneVerified && !ownerUser.phoneVerified) {
        ownerUser.phoneVerified = true;
        changed = true;
      }
      if (changed) {
        await ownerUser.save();
      }
    }

    const token = clubToken(club, ownerUser?._id);

    return res.json({
      ok: true,
      flow,
      channelVerified: channel,
      verified: {
        email: !!club.emailVerified,
        phone: !!club.phoneVerified,
      },
      club: safeClub(club),
      ownerUser: safeUser(ownerUser),
      token,
      capabilities: {
        canManageVenue: true,
        canPlay: true,
      },
    });
  } catch (error) {
    console.error("[CLUB_OTP][VERIFY][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res
      .status(error?.statusCode || 500)
      .json({ message: error?.message || "Internal server error" });
  }
}
