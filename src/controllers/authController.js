import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail, sendOtpSms } from "../services/OTPService.js";

<<<<<<< HEAD
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

  // Twilio returns status "approved" when correct
  return verificationCheck?.status === "approved";
}

// =========================
// Existing helpers (unchanged)
// =========================
=======
>>>>>>> 596c6fc785edc18a3da75574e8b94d521d22f762
function safeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;

  // Remove sensitive fields (support both naming styles)
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

/**
 * Supports:
 * - { emailOrPhone: "abc@email.com" } OR { emailOrPhone: "+447..." }
 * - { identifier: "..." }
 * - { email: "..." } or { phone: "..." }
 */
function pickEmailOrPhone(body) {
  const emailOrPhone = toStr(body.emailOrPhone);
  if (emailOrPhone) {
    if (emailOrPhone.includes("@")) return { email: normalizeEmail(emailOrPhone) };
    return { phone: normalizePhone(emailOrPhone) };
  }

  const identifier = toStr(body.identifier);
  if (identifier) {
    if (identifier.includes("@")) return { email: normalizeEmail(identifier) };
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
  // Supports both { ... } and { data: { ... } }
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

// Detect which password field exists on schema (helps strict schemas)
function getPasswordFromUser(user) {
  // Support both field names
  return user?.passwordHash || user?.password || "";
}

function setPasswordOnUser(user, hash) {
  // Set both; strict schema will keep whichever exists
  user.passwordHash = hash;
  user.password = hash;
}

function pickNickname(body, email, phone) {
  const nickname = toStr(body.nickname);
  if (nickname) return nickname;

  // fallback: email left side or phone, but NEVER "Player"
  if (email && email.includes("@")) {
    const left = email.split("@")[0]?.trim();
    if (left) return left;
  }
  if (phone) return phone;
  return "";
}

<<<<<<< HEAD
// =========================
// ✅ NEW: phone field picker (accept phone or phoneNumber)
// =========================
function pickPhoneInput(body) {
  const raw = toStr(body.phone) || toStr(body.phoneNumber) || "";
  const phone = normalizePhone(raw);
  return phone;
}

// =========================
// ✅ NEW: rate limiting helper (60s)
// =========================
function isRateLimited(lastOtpSent, windowMs = 60_000) {
  if (!lastOtpSent) return false;
  const now = Date.now();
  const last = new Date(lastOtpSent).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < windowMs;
}

// =========================
// Existing endpoints (unchanged)
// =========================
=======
>>>>>>> 596c6fc785edc18a3da75574e8b94d521d22f762
export const signUp = async (req, res) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const password = toStr(body.password);

    // Organizer/player fields: accept but do not break
    const role = toStr(body.role) || toStr(body.userType) || "";
    const organizer = body.organizer && typeof body.organizer === "object" ? body.organizer : null;

    const nickname = pickNickname(body, email, phone);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);

    // Select both password fields in case your schema uses one or the other
    const existing = await User.findOne({ $or: queryOr }).select("+passwordHash +password");

    if (existing) {
      const existingPass = getPasswordFromUser(existing);

      // If user exists but had no local password, "upgrade" it
      if (!existingPass) {
        const hash = await bcrypt.hash(password, 10);
        setPasswordOnUser(existing, hash);

        existing.profile = existing.profile || {};
        if (!existing.profile.nickname && nickname) existing.profile.nickname = nickname;

        existing.stats = existing.stats || {};
        if (!existing.stats.userIdTag) {
          const tag = await createUniqueTag();
          existing.stats.userIdTag = tag;
        }

        // Optional: store role/type if your schema supports it
        if (role) {
          existing.profile.role = existing.profile.role || role;
          existing.profile.userType = existing.profile.userType || role;
        }

        // Optional: store organizer draft if schema supports it (won't crash if strict)
        if (organizer) {
          existing.profile.organizer = organizer;
        }

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
      password: hash, // harmless if schema strict: true (ignored if not defined)
      profile: {
        ...(nickname ? { nickname } : {}),
        ...(role ? { role, userType: role } : {}),
        ...(organizer ? { organizer } : {}),
      },
      stats: { userIdTag: tag },
    };

    const user = await User.create(createDoc);

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][SIGNUP][ERROR]", { requestId, message: error?.message, stack: error?.stack });

    if (error && error.code === 11000) {
      return res.status(409).json({ message: "User exists" });
    }

    // Return the real message so you can debug (remove later if you want)
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
};

export async function login(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const password = toStr(body.password);
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const lookup = pickEmailOrPhone(body);
    if (!lookup.email && !lookup.phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    // Select both possible password fields
    const user = await User.findOne(lookup).select("+passwordHash +password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const stored = getPasswordFromUser(user);
    if (!stored) {
      return res.status(400).json({ message: "No local password set" });
    }

    const ok = await bcrypt.compare(password, stored);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][LOGIN][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

export async function requestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    const code = otpToString(generateOtp(4));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const query = email ? { email } : { phone };

    let user = await User.findOne(query);
    if (!user) {
      const tag = await createUniqueTag();
      user = await User.create({
        ...query,
        otp: { code, expiresAt },
        profile: { ...(email ? { nickname: email.split("@")[0] } : {}) },
        stats: { userIdTag: tag },
      });
    } else {
      user.otp = { code, expiresAt };
      await user.save();
    }

    console.log("[OTP][REQUEST]", {
      requestId,
      via: email ? "email" : "phone",
      to: email || phone,
      userId: user?._id?.toString?.(),
    });

    if (email) await sendOtpEmail(email, code);
    if (phone) await sendOtpSms(phone, code);

    return res.json({ message: "OTP sent" });
  } catch (error) {
    console.error("[OTP][REQUEST][ERROR]", { requestId, message: error?.message, stack: error?.stack });

    if (error && error.code === 11000) {
      return res.json({ message: "OTP sent" });
    }
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

export async function verifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    const otp = otpToString(body.otp);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!otp) {
      return res.status(400).json({ message: "OTP required" });
    }

    const query = email ? { email } : { phone };
    const user = await User.findOne(query);

    if (!user || !user.otp || !user.otp.code) {
      return res.status(404).json({ message: "OTP not found" });
    }

    if (user.otp.expiresAt && user.otp.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    const expected = otpToString(user.otp.code);
    if (expected !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    user.otp = undefined;
    user.profile = user.profile || {};
    user.profile.verified = true;
    await user.save();

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[OTP][VERIFY][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

export async function forgotPassword(req, res) {
  try {
    const body = getBody(req);
    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    const query = email ? { email } : { phone };
    const user = await User.findOne(query);
    if (!user) {
      return res.json({ message: "If the account exists, an OTP was sent" });
    }

    const code = otpToString(generateOtp(4));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = { code, expiresAt };
    await user.save();

    if (email) await sendOtpEmail(email, code);
    if (phone) await sendOtpSms(phone, code);

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
    const phone = lookup.phone;

    const otp = otpToString(body.otp);
    const newPassword = toStr(body.newPassword);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!otp || !newPassword) {
      return res.status(400).json({ message: "otp and newPassword required" });
    }

    const query = email ? { email } : { phone };
    const user = await User.findOne(query).select("+passwordHash +password");

    if (!user || !user.otp || !user.otp.code) {
      return res.status(400).json({ message: "OTP not found" });
    }

    if (user.otp.expiresAt && user.otp.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    const expected = otpToString(user.otp.code);
    if (expected !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

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

    if (!clerkUserId) {
      return res.status(400).json({ message: "clerkUserId required" });
    }

    let user = await User.findOne({ clerkId: clerkUserId });

    if (!user && email) {
      user = await User.findOne({ email });
      if (user) {
        user.clerkId = clerkUserId;
        await user.save();
      }
    }

    if (!user) {
      const tag = await createUniqueTag();
      user = await User.create({
        clerkId: clerkUserId,
        email,
        profile: { ...(name ? { nickname: name } : {}) },
        stats: { userIdTag: tag },
      });
    }

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][CLERK][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "User exists" });
    }
    return res.status(500).json({ message: error?.message || "server error" });
  }
}

<<<<<<< HEAD
// =========================
// ✅ NEW: Phone OTP-only (Twilio Verify) endpoints
// =========================

/**
 * POST /auth/phone/register
 * Body: { phone | phoneNumber }
 * - Creates user if not exists (unverified)
 * - Sends Twilio Verify SMS
 */
export async function phoneRegisterRequestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);
    const phone = pickPhoneInput(body);

    if (!phone) return res.status(400).json({ message: "Phone number is required" });

    let user = await User.findOne({ phone });

    // If already verified -> don't allow "register" again
    if (user && user.phoneVerified) {
      return res.status(409).json({ message: "Number already registered. Please login." });
    }

    // Rate limit OTP sends (60s)
    if (user && isRateLimited(user.lastOtpSent, 60_000)) {
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    const now = new Date();

    if (!user) {
      const tag = await createUniqueTag();
      user = await User.create({
        phone,
        phoneVerified: false,
        lastOtpSent: now,
        profile: { nickname: phone }, // safe default (your model auto-sets avatar)
        stats: { userIdTag: tag },
      });
    } else {
      user.lastOtpSent = now;
      await user.save();
    }

    await twilioSendVerifySms(phone);

    return res.status(200).json({
      message: "Verification code sent",
      nextStep: "VERIFY_CODE",
    });
  } catch (error) {
    console.error("[PHONE][REGISTER][OTP][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Service error. Please try again." });
  }
}

/**
 * POST /auth/phone/verify
 * Body: { phone | phoneNumber, code }
 * - Twilio Verify check
 * - Sets phoneVerified=true
 * - Returns token + user
 */
export async function phoneRegisterVerifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);
    const phone = pickPhoneInput(body);
    const code = toStr(body.code) || toStr(body.otp);

    if (!phone) return res.status(400).json({ message: "Phone number is required" });
    if (!code) return res.status(400).json({ message: "Verification code is required" });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: "Account not found. Please register first." });

    const ok = await twilioCheckVerifyCode(phone, code);
    if (!ok) return res.status(400).json({ message: "Invalid code" });

    user.phoneVerified = true;
    user.lastOtpSent = null;
    user.profile = user.profile || {};
    user.profile.verified = true; // optional: keep consistent with your existing "verified"
    await user.save();

    const token = sign({ id: user._id });
    return res.status(200).json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[PHONE][REGISTER][VERIFY][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Service error. Please try again." });
  }
}

/**
 * POST /auth/phone/login
 * Body: { phone | phoneNumber }
 * - Only for existing verified users
 * - Sends Twilio Verify SMS
 */
export async function phoneLoginRequestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);
    const phone = pickPhoneInput(body);

    if (!phone) return res.status(400).json({ message: "Phone number is required" });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: "Account not found. Please register." });
    if (!user.phoneVerified) return res.status(403).json({ message: "Phone not verified. Please complete signup." });

    // Rate limit OTP sends (60s)
    if (isRateLimited(user.lastOtpSent, 60_000)) {
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    user.lastOtpSent = new Date();
    await user.save();

    await twilioSendVerifySms(phone);

    return res.status(200).json({
      message: "Login code sent",
      nextStep: "VERIFY_CODE",
    });
  } catch (error) {
    console.error("[PHONE][LOGIN][OTP][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Service error. Please try again." });
  }
}

/**
 * POST /auth/phone/login/verify
 * Body: { phone | phoneNumber, code }
 * - Twilio Verify check
 * - Returns token + user
 */
export async function phoneLoginVerifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);
    const phone = pickPhoneInput(body);
    const code = toStr(body.code) || toStr(body.otp);

    if (!phone) return res.status(400).json({ message: "Phone number is required" });
    if (!code) return res.status(400).json({ message: "Verification code is required" });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: "Account not found. Please register." });
    if (!user.phoneVerified) return res.status(403).json({ message: "Phone not verified. Please complete signup." });

    const ok = await twilioCheckVerifyCode(phone, code);
    if (!ok) return res.status(400).json({ message: "Invalid code" });

    user.lastOtpSent = null;
    user.lastSeen = new Date();
    await user.save();

    const token = sign({ id: user._id });
    return res.status(200).json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[PHONE][LOGIN][VERIFY][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Service error. Please try again." });
  }
}
=======
>>>>>>> 596c6fc785edc18a3da75574e8b94d521d22f762
