export async function requestOtp(req, res) {
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
        profile: { nickname: "Player" },
        stats: { userIdTag: tag },
      });
    } else {
      user.otp = { code, expiresAt };
      await user.save();
    }

    console.log("[OTP][REQUEST]", {
      via: email ? "email" : "phone",
      to: email || phone,
      userId: user?._id?.toString?.(),
    });

    if (email) {
      await sendOtpEmail(email, code);
      return res.json({ message: "OTP sent" });
    }

    // phone-based OTP
    await sendOtpSms(phone, code);
    return res.json({ message: "OTP sent" });
  } catch (error) {
    console.error("[OTP][REQUEST][ERROR]", error);

    // ✅ If SMS not implemented (or invalid phone), return 400 not 500
    if (error?.code === "SMS_NOT_IMPLEMENTED" || error?.code === "INVALID_PHONE") {
      return res.status(400).json({ message: error.message });
    }

    // ✅ SMTP/config issues: return a clear message so you can fix Railway vars
    if (
      error?.code === "SMTP_MISSING" ||
      error?.code === "SMTP_VERIFY_FAILED" ||
      error?.code === "SMTP_SEND_FAILED"
    ) {
      return res.status(500).json({ message: error.message });
    }

    // Duplicate key safe fallback
    if (error && error.code === 11000) {
      return res.json({ message: "OTP sent" });
    }

    return res.status(500).json({ message: error?.message || "Internal server error" });
  }
}
