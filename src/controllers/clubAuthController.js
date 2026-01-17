import Club from "../models/club.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail, sendOtpSms } from "../services/OTPService.js";

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

function otpToString(value) {
  return toStr(value);
}

function getBody(req) {
  // Supports both { ... } and { data: { ... } }
  if (req.body?.data && typeof req.body.data === "object") return req.body.data;
  return req.body || {};
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
  // Club-scoped token payload (parallel to player token)
  return sign({ id: clubId, role: "CLUB", typ: "club_access" });
}

// =============================
// CLUB SIGNUP
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

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const queryOr = [email ? { email } : null, phone ? { phone } : null].filter(Boolean);

    const existing = await Club.findOne({ $or: queryOr }).select("+passwordHash +password");
    if (existing) {
      const existingPass = getPasswordFromClub(existing);

      // If club exists but had no local password, "upgrade" it
      if (!existingPass) {
        const hash = await bcrypt.hash(password, 10);
        setPasswordOnClub(existing, hash);

        if (name && !existing.name) existing.name = name;
        if (address && !existing.address) existing.address = address;

        existing.status = existing.status || "PENDING_VERIFICATION";
        await existing.save();

        const token = clubToken(existing._id);
        return res.json({ club: safeClub(existing), token, upgraded: true });
      }

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
      status: "PENDING_VERIFICATION",
      verified: false,
    });

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token });
  } catch (error) {
    console.error("[CLUB_AUTH][SIGNUP][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });

    if (error && error.code === 11000) {
      return res.status(409).json({ message: "Club already exists" });
    }
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
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const lookup = pickEmailOrPhone(body);
    if (!lookup.email && !lookup.phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    const club = await Club.findOne(lookup).select("+passwordHash +password");
    if (!club) {
      return res.status(404).json({ message: "Club not found" });
    }

    const stored = getPasswordFromClub(club);
    if (!stored) {
      return res.status(400).json({ message: "No local password set" });
    }

    const ok = await bcrypt.compare(password, stored);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token });
  } catch (error) {
    console.error("[CLUB_AUTH][LOGIN][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// CLUB OTP REQUEST
// =============================
export async function clubRequestOtp(req, res) {
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
    const expiresAt = new Date(Date.now() + 10 * 60 *_toggle*1000);

    const query = email ? { email } : { phone };

    let club = await Club.findOne(query);
    if (!club) {
      // Create club shell account if it doesn't exist (OTP-first login style)
      club = await Club.create({
        ...query,
        otp: { code, expiresAt },
        status: "PENDING_VERIFICATION",
        verified: false,
      });
    } else {
      club.otp = { code, expiresAt };
      await club.save();
    }

    console.log("[CLUB_OTP][REQUEST]", {
      requestId,
      via: email ? "email" : "phone",
      to: email || phone,
      clubId: club?._id?.toString?.(),
    });

    if (email) await sendOtpEmail(email, code);
    if (phone) await sendOtpSms(phone, code);

    return res.json({ message: "OTP sent" });
  } catch (error) {
    console.error("[CLUB_OTP][REQUEST][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });

    if (error && error.code === 11000) {
      // Duplicate key race: still respond success
      return res.json({ message: "OTP sent" });
    }
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}

// =============================
// CLUB OTP VERIFY
// =============================
export async function clubVerifyOtp(req, res) {
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
    const club = await Club.findOne(query);

    if (!club || !club.otp || !club.otp.code) {
      return res.status(404).json({ message: "OTP not found" });
    }

    if (club.otp.expiresAt && club.otp.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    const expected = otpToString(club.otp.code);
    if (expected !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    club.otp = undefined;
    club.verified = true;

    // Once verified, allow access (still can be pending review based on docs)
    if (club.status === "PENDING_VERIFICATION") club.status = "ACTIVE";

    await club.save();

    const token = clubToken(club._id);
    return res.json({ club: safeClub(club), token });
  } catch (error) {
    console.error("[CLUB_OTP][VERIFY][ERROR]", {
      requestId,
      message: error?.message,
      stack: error?.stack,
    });
    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}
