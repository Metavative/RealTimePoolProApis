 import cypto from "crypto"
 import nodemailer from "nodemailer"


 const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com ",
    port: parseInt(process.env.SMTP_PORT || "587" ),
      secure: false, // true for 465, false for other ports

    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
 
    });

 export function generateOtp(len = 4 ) {
    let otp = "";
    for (let i = 0; i < len; i++) otp += Math.floor(Math.random() * 10);
    return otp;
 }


 export async function sendOtpEmail(email, otp) {
   console.log(process.env.SMTP_USER)
    return transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: "poolPro OTP",
        text: `Your OTP: ${otp}. Valid for 10 minutes. `
    });
 }


 // Placeholder for SMS (Twilio) - implement if you have Twilio key
 export async function sendOtpSms(phone, otp) {
    console.log("SMS OTP -> ", phone, otp);
    return true
 }