import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail } from "../services/OTPService.js";

import twilio from "twilio";

// =========================
// Twilio Verify client setup
// =========================
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || "";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function assertTwilioConfigured() {
  if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
    const err = new Error("Twilio Verify is not configured (missing TWILIO_* env vars)");
    err.statusCode = 500;
    throw err;
  }
}

function isValidE164(phone) {
  return typeof phone === "string" && /^\+\d{8,15}$/.test(phone);
}

async function twilioSendVerifySms(toPhone) {
  assertTwilioConfigured();
  await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create({
    to: toPhone,
    channel: "sms",
  });
}

async function twilioCheckVerifyCode(toPhone, code) {
  assertTwilioConfigured();
  const verificationCheck = await twilioClient.verify.v2
    .services(TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({
      to: toPhone,
      code,
    });

  return verificationCheck?.status === "approved";
}

// =========================
// Helpers
// =========================
function safeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;

  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;

  return obj;
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

/**
 * Supports:
 * - { emailOrPhone: "abc@email.com" } OR { emailOrPhone: "+447..." }
 * - { identifier: "..." }
 * - { email: "..." } or { phone: "..." }
 */
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

function otpToString(value) {
  return toStr(value);
}

function getBody(req) {
  if (req.body?.data && typeof req.body.data === "object") return req.body.data;
  return req.body || {};
}

async function createUniqueTag() {
  for (let i = 0; i < 5; i += 1) {
    const tag = `player_${crypto.randomBytes(3).toString("hex")}`;
    const exists = await User.findOne({ "stats.userIdTag": tag }).select("_id");
    if (!exists) return tag;
  }
  return `player_${crypto.randomBytes(6).toString("hex")}`;
}

function getPasswordFromUser(user) {
  return user?.passwordHash || user?.password || "";
}

function setPasswordOnUser(user, hash) {
  user.passwordHash = hash;
  user.password = hash;
}

function pickNickname(body, email, phone) {
  const nickname = toStr(body.nickname);
  if (nickname) return nickname;

  if (email && email.includes("@")) {
    const left = email.split("@")[0]?.trim();
    if (left) return left;
  }
  if (phone) return phone;
  return "";
}

// ✅ Rate limit helper (60s)
function isRateLimited(lastOtpSent, windowMs = 60_000) {
  if (!lastOtpSent) return false;
  const now = Date.now();
  const last = new Date(lastOtpSent).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < windowMs;
}

// =========================
// PASSWORD signup/login
// =========================
export const signUp = async (req, res) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const password = toStr(body.password);

    const role = toStr(body.role) || toStr(body.userType) || "";
    const organizer = body.organizer && typeof body.organizer === "object" ? body.organizer : null;

    const nickname = pickNickname(body, email, phone);

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });
    if (!password) return res.status(400).json({ message: "Password required" });

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);

    const existing = await User.findOne({ $or: queryOr }).select("+passwordHash +password");
    if (existing) {
      const existingPass = getPasswordFromUser(existing);

      if (!existingPass) {
        const hash = await bcrypt.hash(password, 10);
        setPasswordOnUser(existing, hash);

        existing.profile = existing.profile || {};
        if (!existing.profile.nickname && nickname) existing.profile.nickname = nickname;

        existing.stats = existing.stats || {};
        if (!existing.stats.userIdTag) existing.stats.userIdTag = await createUniqueTag();

        if (role) {
          existing.profile.role = existing.profile.role || role;
          existing.profile.userType = existing.profile.userType || role;
        }

        if (organizer) existing.profile.organizer = organizer;

        await existing.save();

        const token = sign({ id: existing._id });
        return res.json({ user: safeUser(existing), token, upgraded: true });
      }

      return res.status(409).json({ message: "User exists" });
    }

    const hash = await bcrypt.hash(password, 10);
    const tag = await createUniqueTag();

    const createDoc = {
      email,
      phone,
      passwordHash: hash,
      password: hash,
      profile: {
        ...(nickname ? { nickname } : {}),
        ...(role ? { role, userType: role } : {}),
        ...(organizer ? { organizer } : {}),
      },
      stats: { userIdTag: tag },
      emailVerified: false,
      phoneVerified: false,
      lastOtpSent: null,
      lastOtpChannel: null,
    };

    const user = await User.create(createDoc);

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][SIGNUP][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    if (error && error.code === 11000) return res.status(409).json({ message: "User exists" });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
};

export async function login(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const password = toStr(body.password);
    if (!password) return res.status(400).json({ message: "Password required" });

    const lookup = pickEmailOrPhone(body);
    if (!lookup.email && !lookup.phone) return res.status(400).json({ message: "Email or phone required" });

    const user = await User.findOne(lookup).select("+passwordHash +password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const stored = getPasswordFromUser(user);
    if (!stored) return res.status(400).json({ message: "No local password set" });

    const ok = await bcrypt.compare(password, stored);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][LOGIN][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

// =========================
// ✅ UNIFIED OTP REQUEST
// =========================
export async function requestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    const flow = toStr(body.flow) || "login"; // signup|login

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone" && !isValidE164(phone)) {
      return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    let user = await User.findOne(query);

    // login requires existing
    if (flow === "login" && !user) {
      return res.status(404).json({ message: "Account not found. Please sign up." });
    }

    // signup can create shell
    if (!user) {
      user = await User.create({
        ...query,
        phoneVerified: false,
        emailVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
        profile: { ...(email ? { nickname: email.split("@")[0] } : phone ? { nickname: phone } : {}) },
        stats: { userIdTag: await createUniqueTag() },
      });
    }

    if (isRateLimited(user.lastOtpSent, 60_000)) {
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    user.lastOtpSent = new Date();
    user.lastOtpChannel = channel;

    if (channel === "email") {
      const code = otpToString(generateOtp(4));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      user.otp = { code, expiresAt };
      await user.save();

      await sendOtpEmail(email, code);

      return res.json({ ok: true, message: "OTP sent", channel: "email", target: email });
    }

    // phone -> Twilio Verify
    user.otp = undefined;
    await user.save();

    await twilioSendVerifySms(phone);

    return res.json({ ok: true, message: "OTP sent", channel: "phone", target: phone });
  } catch (error) {
    console.error("[OTP][REQUEST][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}

// =========================
// ✅ UNIFIED OTP VERIFY
// =========================
export async function verifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    const code = otpToString(body.code || body.otp);

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });
    if (!code) return res.status(400).json({ message: "OTP required" });

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone" && !isValidE164(phone)) {
      return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    const user = await User.findOne(query);
    if (!user) return res.status(404).json({ message: "Account not found" });

    if (channel === "email") {
      if (!user.otp || !user.otp.code) return res.status(404).json({ message: "OTP not found" });

      if (user.otp.expiresAt && user.otp.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ message: "OTP expired" });
      }

      const expected = otpToString(user.otp.code);
      if (expected !== code) return res.status(400).json({ message: "Invalid OTP" });

      user.otp = undefined;
      user.emailVerified = true;
      user.lastOtpSent = null;
      user.lastOtpChannel = null; // ✅ FIX

      user.profile = user.profile || {};
      user.profile.verified = true;

      await user.save();

      const token = sign({ id: user._id });
      return res.json({ user: safeUser(user), token, channel: "email" });
    }

    // phone -> Twilio Verify
    const ok = await twilioCheckVerifyCode(phone, code);
    if (!ok) return res.status(400).json({ message: "Invalid OTP" });

    user.phoneVerified = true;
    user.lastOtpSent = null;
    user.lastOtpChannel = null;

    user.profile = user.profile || {};
    user.profile.verified = true;

    await user.save();

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token, channel: "phone" });
  } catch (error) {
    console.error("[OTP][VERIFY][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}

// =========================
// forgot/reset password (email only)
// =========================
export async function forgotPassword(req, res) {
  try {
    const body = getBody(req);
    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    const query = email ? { email } : { phone };
    const user = await User.findOne(query);
    if (!user) return res.json({ message: "If the account exists, an OTP was sent" });

    if (!email) return res.status(400).json({ message: "Password reset requires email for now" });

    const code = otpToString(generateOtp(4));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = { code, expiresAt };
    await user.save();

    await sendOtpEmail(email, code);

    return res.json({ message: "Reset OTP sent" });
  } catch (error) {
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

export async function resetPassword(req, res) {
  try {
    const body = getBody(req);
    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;

    const otp = otpToString(body.otp || body.code);
    const newPassword = toStr(body.newPassword || body.password);

    if (!email) return res.status(400).json({ message: "Email required" });
    if (!otp || !newPassword) return res.status(400).json({ message: "otp and newPassword required" });

    const user = await User.findOne({ email }).select("+passwordHash +password");
    if (!user || !user.otp || !user.otp.code) return res.status(400).json({ message: "OTP not found" });

    if (user.otp.expiresAt && user.otp.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    const expected = otpToString(user.otp.code);
    if (expected !== otp) return res.status(400).json({ message: "Invalid OTP" });

    const hash = await bcrypt.hash(newPassword, 10);
    setPasswordOnUser(user, hash);

    user.otp = undefined;
    await user.save();

    return res.json({ message: "Password reset" });
  } catch (error) {
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

export async function clerkLogin(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const clerkUserId = toStr(body.clerkUserId);
    const email = normalizeEmail(body.email);
    const name = toStr(body.name);

    if (!clerkUserId) return res.status(400).json({ message: "clerkUserId required" });

    let user = await User.findOne({ clerkId: clerkUserId });

    if (!user && email) {
      user = await User.findOne({ email });
      if (user) {
        user.clerkId = clerkUserId;
        await user.save();
      }
    }

    if (!user) {
      user = await User.create({
        clerkId: clerkUserId,
        email,
        profile: { ...(name ? { nickname: name } : {}) },
        stats: { userIdTag: await createUniqueTag() },
      });
    }

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][CLERK][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    if (error && error.code === 11000) return res.status(409).json({ message: "User exists" });
    return res.status(500).json({ message: error?.message || "server error" });
  }
}
