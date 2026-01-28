import nodemailer from "nodemailer";

const SMTP_HOST = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();

let _verified = false;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

export function generateOtp(len = 4) {
  let otp = "";
  for (let i = 0; i < len; i += 1) otp += Math.floor(Math.random() * 10);
  return otp;
}

async function ensureTransporterReady() {
  if (_verified) return true;

  if (!SMTP_USER || !SMTP_PASS) {
    const err = new Error("SMTP credentials missing (SMTP_USER or SMTP_PASS)");
    err.code = "SMTP_MISSING";
    throw err;
  }

  try {
    await transporter.verify();
    _verified = true;
    return true;
  } catch (e) {
    const err = new Error(`SMTP verify failed: ${e?.message || "Unable to connect/authenticate"}`);
    err.code = "SMTP_VERIFY_FAILED";
    throw err;
  }
}

export async function sendOtpEmail(email, otp) {
  const to = String(email).trim().toLowerCase();
  if (!to || !to.includes("@")) {
    const err = new Error("Invalid email address");
    err.code = "INVALID_EMAIL";
    throw err;
  }

  await ensureTransporterReady();

  try {
    return await transporter.sendMail({
      from: SMTP_USER,
      to,
      subject: "poolPro OTP",
      text: `Your OTP: ${otp}. Valid for 10 minutes.`,
    });
  } catch (e) {
    const err = new Error(`Failed to send email OTP: ${e?.message || "Unknown error"}`);
    err.code = "SMTP_SEND_FAILED";
    throw err;
  }
}

/**
 * Legacy stub (do not use for OTP).
 * Phone OTP must be handled by Twilio Verify in controllers.
 */
export async function sendOtpSms(phone, otp) {
  const p = String(phone || "").trim();
  if (!p) {
    const err = new Error("Invalid phone number");
    err.code = "INVALID_PHONE";
    throw err;
  }

  const err = new Error(
    "SMS OTP is handled by Twilio Verify. Do not use sendOtpSms(). Use /otp/request for phone which triggers Twilio Verify."
  );
  err.code = "SMS_DEPRECATED_USE_TWILIO_VERIFY";
  err.statusCode = 400;
  throw err;
}
