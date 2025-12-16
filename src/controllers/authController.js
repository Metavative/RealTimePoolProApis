import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail, sendOtpSms } from "../services/OTPService.js";

function safeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;
  delete obj.passwordHash;
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

function pickEmailOrPhone(body) {
  const emailOrPhone = toStr(body.emailOrPhone);
  if (emailOrPhone) {
    if (emailOrPhone.includes("@")) return { email: normalizeEmail(emailOrPhone) };
    return { phone: normalizePhone(emailOrPhone) };
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

async function createUniqueTag() {
  for (let i = 0; i < 5; i += 1) {
    const tag = `player_${crypto.randomBytes(3).toString("hex")}`;
    const exists = await User.findOne({ "stats.userIdTag": tag }).select("_id");
    if (!exists) return tag;
  }
  return `player_${crypto.randomBytes(6).toString("hex")}`;
}

export const signUp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const password = toStr(req.body.password);
    const nickname = toStr(req.body.nickname);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const queryOr = [
      email ? { email } : null,
      phone ? { phone } : null,
    ].filter(Boolean);

    const existing = await User.findOne({ $or: queryOr }).select("+passwordHash");

    if (existing) {
      if (!existing.passwordHash) {
        existing.passwordHash = await bcrypt.hash(password, 10);
        if (!existing.profile) existing.profile = {};
        if (!existing.profile.nickname) existing.profile.nickname = nickname || "Player";
        if (!existing.stats || !existing.stats.userIdTag) {
          const tag = await createUniqueTag();
          existing.stats = { ...(existing.stats || {}), userIdTag: tag };
        }
        await existing.save();

        const token = sign({ id: existing._id });
        return res.json({ user: safeUser(existing), token, upgraded: true });
      }

      return res.status(409).json({ message: "User exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const tag = await createUniqueTag();

    const user = await User.create({
      email,
      phone,
      passwordHash,
      profile: { nickname: nickname || "Player" },
      stats: { userIdTag: tag },
    });

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "User exists" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
};

export async function login(req, res) {
  try {
    const password = toStr(req.body.password);
    if (!password) {
      return res.status(400).json({ message: "Password required" });
    }

    const lookup = pickEmailOrPhone(req.body);
    if (!lookup.email && !lookup.phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    const user = await User.findOne(lookup).select("+passwordHash");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.passwordHash) {
      return res.status(400).json({ message: "No local password set" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function requestOtp(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);

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
        profile: { nickname: "Player" },
        stats: { userIdTag: tag },
      });
    } else {
      user.otp = { code, expiresAt };
      await user.save();
    }

    if (email) await sendOtpEmail(email, code);
    if (phone) await sendOtpSms(phone, code);

    return res.json({ message: "OTP sent" });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.json({ message: "OTP sent" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function verifyOtp(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const otp = otpToString(req.body.otp);

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
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function forgotPassword(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);

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
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function resetPassword(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const otp = otpToString(req.body.otp);
    const newPassword = toStr(req.body.newPassword);

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }
    if (!otp || !newPassword) {
      return res.status(400).json({ message: "otp and newPassword required" });
    }

    const query = email ? { email } : { phone };
    const user = await User.findOne(query).select("+passwordHash");

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

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.otp = undefined;
    await user.save();

    return res.json({ message: "Password reset" });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function clerkLogin(req, res) {
  try {
    const clerkUserId = toStr(req.body.clerkUserId);
    const email = normalizeEmail(req.body.email);
    const name = toStr(req.body.name);

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
        profile: { nickname: name || "Player" },
        stats: { userIdTag: tag },
      });
    }

    const token = sign({ id: user._id });
    return res.json({ user: safeUser(user), token });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "User exists" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
}
