import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import twilio from "twilio";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail } from "../services/OTPService.js";

// ✅ Only these 2 env vars required
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();

// Prefer env for environment-specific Twilio Verify service.
const DEFAULT_TWILIO_VERIFY_SERVICE_SID = "VA5340451db0245afdf3c1515254edf2cf";
const TWILIO_VERIFY_SERVICE_SID = (
  process.env.TWILIO_VERIFY_SERVICE_SID ||
  DEFAULT_TWILIO_VERIFY_SERVICE_SID
).trim();

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function assertTwilioConfigured() {
  if (!twilioClient) {
    const err = new Error("Twilio is not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
    err.statusCode = 500;
    throw err;
  }
  if (!TWILIO_VERIFY_SERVICE_SID) {
    const err = new Error("Twilio Verify Service SID is missing (set TWILIO_VERIFY_SERVICE_SID)");
    err.statusCode = 500;
    throw err;
  }
}

// Any country supported as long as E.164 format
function isValidE164(phone) {
  return typeof phone === "string" && /^\+\d{8,15}$/.test(phone.trim());
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

// =========================
// Helpers
// =========================
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

function safeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;
  delete obj.passwordHash;
  delete obj.password;
  delete obj.otp;
  return obj;
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

function isRateLimited(lastOtpSent, windowMs = 60_000) {
  if (!lastOtpSent) return false;
  const now = Date.now();
  const last = new Date(lastOtpSent).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < windowMs;
}

function duplicateIdentityResponse({ email, phone, existing }) {
  const existingEmail = normalizeEmail(existing?.email);
  const existingPhone = normalizePhone(existing?.phone);

  if (email && existingEmail && email === existingEmail) {
    return { code: "EMAIL_TAKEN", message: "Email already registered" };
  }
  if (phone && existingPhone && phone === existingPhone) {
    return { code: "PHONE_TAKEN", message: "Phone number already registered" };
  }
  return {
    code: "ACCOUNT_EXISTS",
    message: "An account with this email or phone already exists",
  };
}

function duplicateKeyErrorResponse(error) {
  const keyPattern = error?.keyPattern || {};
  const keyValue = error?.keyValue || {};

  if (keyPattern.email || Object.prototype.hasOwnProperty.call(keyValue, "email")) {
    return { code: "EMAIL_TAKEN", message: "Email already registered" };
  }
  if (keyPattern.phone || Object.prototype.hasOwnProperty.call(keyValue, "phone")) {
    return { code: "PHONE_TAKEN", message: "Phone number already registered" };
  }
  if (
    keyPattern.username ||
    keyPattern.usernameLower ||
    Object.prototype.hasOwnProperty.call(keyValue, "username") ||
    Object.prototype.hasOwnProperty.call(keyValue, "usernameLower")
  ) {
    return { code: "USERNAME_TAKEN", message: "Username already taken" };
  }

  return {
    code: "DUPLICATE_VALUE",
    message: "Duplicate value (email/phone/username) already exists",
  };
}

// =========================
// Name helpers
// =========================
function normalizeName(v) {
  const s = toStr(v);
  return s ? s.replace(/\s+/g, " ").trim() : "";
}

function isLikelyHumanName(v) {
  const s = normalizeName(v);
  if (!s) return false;
  if (s.length < 2) return false;
  return /^[a-zA-ZÀ-ÿ\s'\-]+$/.test(s);
}

// =========================
// Username validation
// =========================
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "support",
  "help",
  "system",
  "moderator",
  "mod",
  "player",
  "null",
  "undefined",
  "root",
]);

function normalizeUsername(username) {
  const raw = toStr(username);
  if (!raw) return { raw: "", lower: "" };
  return { raw, lower: raw.toLowerCase() };
}

function validateUsernameOrThrow(username) {
  const { raw, lower } = normalizeUsername(username);
  if (!raw) {
    const err = new Error("Username required");
    err.statusCode = 400;
    throw err;
  }
  if (!USERNAME_REGEX.test(raw)) {
    const err = new Error("Invalid username. Use 3-20 characters: letters, numbers, underscore.");
    err.statusCode = 400;
    throw err;
  }
  if (/^error\d*$/i.test(raw)) {
    const err = new Error("This username is reserved. Please choose another.");
    err.statusCode = 400;
    throw err;
  }
  if (RESERVED_USERNAMES.has(lower)) {
    const err = new Error("This username is reserved. Please choose another.");
    err.statusCode = 400;
    throw err;
  }
  return { raw, lower };
}

function canChangeUsername(user) {
  if (!user) return true;
  const hasPassword = !!getPasswordFromUser(user);
  const verified = !!user.emailVerified || !!user.phoneVerified;
  // ✅ if password set or verified, treat as "final"
  return !(hasPassword || verified);
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

    // ✅ REQUIRED USERNAME
    const { raw: username, lower: usernameLower } = validateUsernameOrThrow(body.username);

    const role = toStr(body.role) || toStr(body.userType) || "";
    const organizer = body.organizer && typeof body.organizer === "object" ? body.organizer : null;

    const nickname = pickNickname(body, email, phone);
    const preferredNickname = username || nickname;

    // ✅ player fields
    const firstName = normalizeName(body.firstName);
    const lastName = normalizeName(body.lastName);
    const isPlayer = (role || "").toLowerCase() === "player";

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });
    if (!password) return res.status(400).json({ message: "Password required" });

    if (isPlayer) {
      if (!firstName || !lastName) {
        return res.status(400).json({ message: "First name and last name required" });
      }
      if (!isLikelyHumanName(firstName) || !isLikelyHumanName(lastName)) {
        return res.status(400).json({ message: "Invalid first/last name" });
      }
    }

    // ✅ FIRST: find existing user by email/phone (placeholder or real)
    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);
    const existing = await User.findOne({ $or: queryOr }).select("+passwordHash +password");

    // ✅ If existing user present, handle upgrade/signup completion
    if (existing) {
      const existingPass = getPasswordFromUser(existing);

      if (existingPass) {
        const conflict = duplicateIdentityResponse({ email, phone, existing });
        return res.status(409).json(conflict);
      }

      // If username differs:
      if (existing.usernameLower && existing.usernameLower !== usernameLower) {
        // If account is final, block
        if (!canChangeUsername(existing)) {
          return res.status(409).json({
            code: "USERNAME_LOCKED",
            message: "This account is already created. You can’t change the username here.",
          });
        }

        // Otherwise allow change ONLY if not taken by someone else
        const takenByOther = await User.findOne({
          usernameLower,
          _id: { $ne: existing._id },
        }).select("_id username");
        if (takenByOther) {
          return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
        }

        existing.username = username; // pre-save sets usernameLower
      } else if (!existing.username) {
        existing.username = username;
      }

      // Upgrade placeholder: set password + fill profile
      const hash = await bcrypt.hash(password, 10);
      setPasswordOnUser(existing, hash);

      existing.profile = existing.profile || {};
      if (!existing.profile.nickname && preferredNickname) {
        existing.profile.nickname = preferredNickname;
      }

      if (isPlayer) {
        existing.profile.firstName = existing.profile.firstName || firstName;
        existing.profile.lastName = existing.profile.lastName || lastName;
        existing.profile.legalName = existing.profile.legalName || `${firstName} ${lastName}`.trim();
      }

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

    // ✅ NEW USER: ensure username isn’t taken
    const existingUsername = await User.findOne({ usernameLower }).select("_id username");
    if (existingUsername) {
      return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
    }

    const hash = await bcrypt.hash(password, 10);
    const tag = await createUniqueTag();

    const user = await User.create({
      email,
      phone,
      username,
      profile: {
        ...(preferredNickname ? { nickname: preferredNickname } : {}),
        ...(role ? { role, userType: role } : {}),
        ...(organizer ? { organizer } : {}),
        ...(isPlayer
          ? { firstName, lastName, legalName: `${firstName} ${lastName}`.trim() }
          : {}),
      },
      stats: { userIdTag: tag },
      emailVerified: false,
      phoneVerified: false,
      lastOtpSent: null,
      lastOtpChannel: null,
      passwordHash: hash,
      password: hash,
    });

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    console.error("[AUTH][SIGNUP][ERROR]", { message: error?.message, stack: error?.stack });

    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message });

    if (error && error.code === 11000) {
      return res.status(409).json(duplicateKeyErrorResponse(error));
    }
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

// =======================================================
// ✅ SIGNUP OTP REQUEST (send to BOTH email + phone)
// =======================================================
export async function requestSignupOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");

  const log = (step, extra = {}) => {
    console.log(`[OTP][SIGNUP_REQUEST][${requestId}] ${step}`, extra);
  };

  try {
    const body = getBody(req);

    const { raw: username, lower: usernameLower } = validateUsernameOrThrow(body.username);

    const email =
      normalizeEmail(body.email) ||
      (isEmailIdentifier(toStr(body.identifier)) ? normalizeEmail(body.identifier) : undefined);

    const phone =
      normalizePhone(body.phone) ||
      (!isEmailIdentifier(toStr(body.identifier)) ? normalizePhone(body.identifier) : undefined);

    log("INPUT", { username, email, phone });

    if (!email && !phone) return res.status(400).json({ message: "Email or phone required" });

    if (phone && !isValidE164(phone)) {
      log("INVALID_PHONE_FORMAT", { phone });
      return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);
    let user = queryOr.length ? await User.findOne({ $or: queryOr }).select("+passwordHash +password") : null;

    if (user) {
      const usernameCanChange = canChangeUsername(user);

      // If username differs and account is final -> block
      if (!usernameCanChange && user.usernameLower && user.usernameLower !== usernameLower) {
        return res.status(409).json({
          code: "USERNAME_LOCKED",
          message: "This account is already created. You can’t change the username here.",
        });
      }

      // If username differs and still in signup -> allow change if not taken by someone else
      if (user.usernameLower !== usernameLower) {
        const usernameTakenByOther = await User.findOne({
          usernameLower,
          _id: { $ne: user._id },
        }).select("_id username");

        if (usernameTakenByOther) {
          return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
        }

        user.username = username; // pre-save sets usernameLower
      }

      user.stats = user.stats || {};
      if (!user.stats.userIdTag) user.stats.userIdTag = await createUniqueTag();
    } else {
      // No user exists yet -> ensure username is free
      const usernameTaken = await User.findOne({ usernameLower }).select("_id username");
      if (usernameTaken) {
        return res.status(409).json({ code: "USERNAME_TAKEN", message: "Username already taken" });
      }

      log("USER_NOT_FOUND_CREATING");
      user = await User.create({
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        username,
        phoneVerified: false,
        emailVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
        profile: { ...(username ? { nickname: username } : {}) },
        stats: { userIdTag: await createUniqueTag() },
      });
    }

    if (isRateLimited(user.lastOtpSent, 60_000)) {
      log("RATE_LIMITED", { lastOtpSent: user.lastOtpSent });
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    user.lastOtpSent = new Date();
    user.lastOtpChannel = "multi";

    const channelsSent = [];
    const channelsFailed = [];
    const channelsAttempted = [];

    // ===== EMAIL OTP (DB stored) =====
    if (user.email) {
      channelsAttempted.push("email");
      try {
        const code = otpToString(generateOtp(6));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        user.otp = { code, expiresAt };
        await user.save();

        await sendOtpEmail(user.email, code);
        channelsSent.push("email");
      } catch (e) {
        channelsFailed.push({ channel: "email", error: e?.message || "email_failed" });
      }
    } else {
      user.otp = undefined;
      await user.save();
    }

    // ===== PHONE OTP via Twilio Verify =====
    if (user.phone) {
      channelsAttempted.push("phone");
      try {
        if (!isValidE164(user.phone)) {
          channelsFailed.push({ channel: "phone", error: "invalid_e164" });
        } else {
          await twilioSendVerifySms(user.phone);
          channelsSent.push("phone");
        }
      } catch (e) {
        channelsFailed.push({ channel: "phone", error: e?.message || "twilio_failed" });
      }
    }

    const ok = channelsSent.length > 0;

    return res.json({
      ok,
      message: ok ? "Signup OTP sent" : "Failed to send OTP",
      flow: "signup",
      username,
      target: { ...(user.email ? { email: user.email } : {}), ...(user.phone ? { phone: user.phone } : {}) },
      channelsAttempted,
      channelsSent,
      channelsFailed,
    });
  } catch (error) {
    console.error("[OTP][SIGNUP_REQUEST][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}

// =========================
// ✅ OTP REQUEST: login (single-channel)
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

    let requestedUsername = null;
    if (flow === "signup") {
      const usernameInput =
        toStr(body.username) ||
        toStr(body.userName) ||
        toStr(body.nickname) ||
        toStr(body.handle);
      requestedUsername = validateUsernameOrThrow(usernameInput).raw;
    }

    const channel = email ? "email" : "phone";
    const query = email ? { email } : { phone };

    if (channel === "phone" && !isValidE164(phone)) {
      return res.status(400).json({ message: "Phone must be in E.164 format, e.g. +447911123456" });
    }

    let user = await User.findOne(query);

    if (flow === "login" && !user) {
      return res.status(404).json({ message: "Account not found. Please sign up." });
    }

    if (!user) {
      user = await User.create({
        ...query,
        ...(requestedUsername ? { username: requestedUsername } : {}),
        phoneVerified: false,
        emailVerified: false,
        lastOtpSent: null,
        lastOtpChannel: null,
        profile: { ...(requestedUsername ? { nickname: requestedUsername } : {}) },
        stats: { userIdTag: await createUniqueTag() },
      });
    }

    if (isRateLimited(user.lastOtpSent, 60_000)) {
      return res.status(429).json({ message: "Please wait 60 seconds before requesting another code." });
    }

    user.lastOtpSent = new Date();
    user.lastOtpChannel = channel;

    if (channel === "email") {
      const code = otpToString(generateOtp(6));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      user.otp = { code, expiresAt };
      await user.save();

      await sendOtpEmail(email, code);

      return res.json({ ok: true, message: "OTP sent", channel: "email", target: email, flow });
    }

    user.otp = undefined;
    await user.save();
    await twilioSendVerifySms(phone);

    return res.json({ ok: true, message: "OTP sent", channel: "phone", target: phone, flow });
  } catch (error) {
    console.error("[OTP][REQUEST][ERROR]", { requestId, message: error?.message, stack: error?.stack });
    return res.status(error?.statusCode || 500).json({ message: error?.message || "Internal server error" });
  }
}

// =========================
// ✅ OTP VERIFY
// =========================
export async function verifyOtp(req, res) {
  const requestId = crypto.randomBytes(4).toString("hex");
  try {
    const body = getBody(req);

    const lookup = pickEmailOrPhone(body);
    const email = lookup.email;
    const phone = lookup.phone;

    const flow = toStr(body.flow) || "login";
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
      user.lastOtpChannel = null;

      user.profile = user.profile || {};
      user.profile.verified = true;

      await user.save();
    } else {
      const ok = await twilioCheckVerifyCode(phone, code);
      if (!ok) return res.status(400).json({ message: "Invalid OTP" });

      user.phoneVerified = true;

      user.lastOtpSent = null;
      user.lastOtpChannel = null;

      user.profile = user.profile || {};
      user.profile.verified = true;

      await user.save();
    }

    const token = sign({ id: user._id });
    return res.json({
      ok: true,
      flow,
      channelVerified: channel,
      verified: { email: !!user.emailVerified, phone: !!user.phoneVerified },
      user: safeUser(user),
      token,
    });
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

    if (!email) return res.status(400).json({ message: "Password reset requires email for now" });

    const user = await User.findOne({ email });
    if (!user) return res.json({ message: "If the account exists, an OTP was sent" });

    const code = otpToString(generateOtp(6));
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
    const email = normalizeEmail(body.email);
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

// ✅ IMPORTANT: keep this export so auth.route.js never crashes
export async function clerkLogin(req, res) {
  return res.status(501).json({ message: "clerkLogin not implemented" });
}

// ✅ Backward-compatible exports for old routes (so imports won’t crash)
export async function phoneRegisterRequestOtp(req, res) {
  const body = req.body || {};
  req.body = {
    ...body,
    phone: body.phone || body.phoneNumber,
    username: body.username || body.userName || body.nickname || body.handle,
    flow: "signup",
  };
  return requestOtp(req, res);
}
export async function phoneRegisterVerifyOtp(req, res) {
  req.body = {
    ...(req.body || {}),
    phone: req.body?.phone || req.body?.phoneNumber,
    otp: req.body?.otp || req.body?.code,
    flow: "signup",
  };
  return verifyOtp(req, res);
}
export async function phoneLoginRequestOtp(req, res) {
  req.body = { ...(req.body || {}), phone: req.body?.phone || req.body?.phoneNumber, flow: "login" };
  return requestOtp(req, res);
}
export async function phoneLoginVerifyOtp(req, res) {
  req.body = {
    ...(req.body || {}),
    phone: req.body?.phone || req.body?.phoneNumber,
    otp: req.body?.otp || req.body?.code,
    flow: "login",
  };
  return verifyOtp(req, res);
}
