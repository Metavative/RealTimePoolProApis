import Club from "../models/club.model.js";
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
const TWILIO_VERIFY_SERVICE_SID = "VA5340451db0245afdf3c1515254edf2cf";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function assertTwilioConfigured() {
  if (!twilioClient) {
    const err = new Error("Twilio is not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
    err.statusCode = 500;
    throw err;
  }
  if (!TWILIO_VERIFY_SERVICE_SID) {
    const err = new Error("Twilio Verify Service SID is missing (hardcoded constant is empty)");
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

function safeClub(club) {
  if (!club) return null;
  const obj = club.toObject ? club.toObject() : club;
  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;
  return obj;
}

function getPasswordFromClub(club) {
  return club?.passwordHash || club?.password || "";
}

function setPasswordOnClub(club, hash) {
  club.passwordHash = hash;
  club.password = hash;
}

function clubToken(clubId) {
  return sign({ id: clubId, role: "CLUB", typ: "club_access" });
}

function isRateLimited(lastOtpSent, windowMs = 60_000) {
  if (!lastOtpSent) return false;
  const now = Date.now();
  const last = new Date(lastOtpSent).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < windowMs;
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

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });
    if (!password) return res.status(400).json({ message: "Password required" });

    if (phone && !isValidE164(phone)) {
      return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);

    const existing = await Club.findOne({ $or: queryOr }).select("+passwordHash +password");
    if (existing) return res.status(409).json({ message: "Club already exists" });

    const hash = await bcrypt.hash(password, 10);

    const club = await Club.create({
      email,
      phone,
      passwordHash: hash,
      password: hash,
      name,
      address,
      status: "PENDING_VERIFICATION",
      verified: false,
      emailVerified: false,
      phoneVerified: false,
      lastOtpSent: null,
      lastOtpChannel: null,
    });

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token });
  } catch (error) {
    console.error("[CLUB_AUTH][SIGNUP][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    if (error && error.code === 11000) return res.status(409).json({ message: "Club already exists" });
    return res.status(500).json({ message: error?.message || "Internal server error" });
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
    if (!lookup.email && !lookup.phone) return res.status(400).json({ message: "Email or phone required" });

    const club = await Club.findOne(lookup).select("+passwordHash +password");
    if (!club) return res.status(404).json({ message: "Club not found" });

    const stored = getPasswordFromClub(club);
    if (!stored) return res.status(400).json({ message: "No local password set" });

    const ok = await bcrypt.compare(password, stored);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token });
  } catch (error) {
    console.error("[CLUB_AUTH][LOGIN][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// ✅ UNIFIED CLUB OTP REQUEST
// =============================
export async function clubRequestOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    const flow = toStr(body.flow) || "login";

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone") {
      if (!isValidE164(phone)) {
        return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
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
        status: "PENDING_VERIFICATION",
        verified: false,
        emailVerified: false,
        phoneVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
      });
    }

    if (isRateLimited(club.lastOtpSent, 60_000)) {
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    club.lastOtpSent = new Date();
    club.lastOtpChannel = channel;

    if (channel === "email") {
      const code = otpToString(generateOtp(4));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      club.otp = { code, expiresAt };
      await club.save();

      await sendOtpEmail(email, code);

      return res.json({ ok: true, message: "OTP sent", channel: "email", target: email });
    }

    // phone -> Twilio Verify
    club.otp = undefined;
    await club.save();

    await twilioSendVerifySms(phone);

    return res.json({ ok: true, message: "OTP sent", channel: "phone", target: phone });
  } catch (error) {
    console.error("[CLUB_OTP][REQUEST][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// ✅ UNIFIED CLUB OTP VERIFY
// =============================
export async function clubVerifyOtp(req, res) {
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

    if (channel === "phone") {
      if (!isValidE164(phone)) {
        return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
      }
      assertTwilioConfigured();
    }

    const club = await Club.findOne(query);
    if (!club) return res.status(404).json({ message: "Club not found" });

    if (channel === "email") {
      if (!club.otp || !club.otp.code) return res.status(404).json({ message: "OTP not found" });

      if (club.otp.expiresAt && club.otp.expiresAt.getTime() < Date.now()) {
        return res.status(400).json({ message: "OTP expired" });
      }

      if (otpToString(club.otp.code) !== code) return res.status(400).json({ message: "Invalid OTP" });

      club.otp = undefined;
      club.emailVerified = true;
      club.lastOtpSent = null;
      club.lastOtpChannel = null;

      club.verified = true;
      if (club.status === "PENDING_VERIFICATION") club.status = "ACTIVE";

      await club.save();

      const token = clubToken(club._id);
      return res.json({ club: safeClub(club), token, channel: "email" });
    }

    const ok = await twilioCheckVerifyCode(phone, code);
    if (!ok) return res.status(400).json({ message: "Invalid OTP" });

    club.phoneVerified = true;
    club.lastOtpSent = null;
    club.lastOtpChannel = null;

    club.verified = true;
    if (club.status === "PENDING_VERIFICATION") club.status = "ACTIVE";

    await club.save();

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token, channel: "phone" });
  } catch (error) {
    console.error("[CLUB_OTP][VERIFY][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}
