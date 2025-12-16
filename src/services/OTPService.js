import nodemailer from "nodemailer";

const SMTP_HOST = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

export function generateOtp(len = 4) {
  let otp = "";
  for (let i = 0; i < len; i++) otp += Math.floor(Math.random() * 10);
  return otp;
}

export async function sendOtpEmail(email, otp) {
  if (!SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP credentials missing (SMTP_USER or SMTP_PASS)");
  }

  return transporter.sendMail({
    from: SMTP_USER,
    to: String(email).trim(),
    subject: "poolPro OTP",
    text: `Your OTP: ${otp}. Valid for 10 minutes.`,
  });
}

export async function sendOtpSms(phone, otp) {
  console.log("SMS OTP ->", phone, otp);
  return true;
}
