import User from "../models/user.model.js";
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { sign } from "../services/jwtService.js";
import { generateOtp, sendOtpEmail, sendOtpSms } from "../services/otpService.js";

export const signUp = async (req,res) => {
    try {
        const { email, phone, password, nickname } = req.body;
    
    if(!email && !phone) return res.status(400).json({
        message: "Email or phone required"
    });

    const exists = await User.findOne({ $or: [{ email }, {
        phone
    }]});

    if (exists) return res.status(400).json({
        message: "User exists"
    });

    const hash = await bcrypt.hash(password, 10);
    const tag = `player_${crypto.randomBytes(3).toString("hex")}`;

    const user = await User.create({
        email,
        phone,
        passwordHash: hash,
        profile: { nickname },
        "state.userIdTaq": tag,
    });
    const token = sign({ id: user._id});
    res.json({ user, token });
    } catch (error) {
        res.status(500).json({
            messgae: error.message
        });
    }
    
}  

// ==================== LOGIN  ======================
export async function login(req, res) {
    
    try {
        const { emailOrPhone, password } = req.body;
    const user = await User.findOne({ $or: [{ email: emailOrPhone}, { phone: emailOrPhone }]});

    if( !user ) {
        return res.status(404).json({message: "User not found" });
    }

    if (!user.passwordHash) {
        return res.status(400).json({
            message: "No local password set"
        });
    }

    const matchPassword = await bcrypt.compare(password, user.passwordHash);

    if( !matchPassword ) {
        return res.status(401).json({
            message: "Invalid credentials"
        });
    }

    const token = sign({ id: user._id });
    res.json({ user, token});

    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }

}

export async function requestOtp(req, res) {
    try {
        const { email, phone } = req.body;

        if(!email && !phone) return res.status(400).json({
            message: "Email or phone required"
        });

        // Generate OTP
        const code = generateOtp(4);
        // EXPIRE AT
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        let user = await User.findOne( email ? { email } : { phone });

        if( !user ) {
            user = await User.create({ email, phone, otp: {code, expiresAt}});

        } else {
            user.otp = { code, expiresAt };
            await user.save();
        }

        if (email) await sendOtpEmail(email, code);
        if( phone ) await sendOtpSms(phone, code);

        res.json({ message: "OTP sent"});

    } catch (error) {
        res.status(500).json({ message: error.message});
    }
}

export async function verifyOtp(req, res) {
    try {
        const { email, phone, otp } = req.body;

        const user = await User.findOne( email ? {email} : { phone } );

        if(!user || !user.otp ) {
            return res.status(404).json({
                message: "OTP not found"
            });
        }

        if ( user.otp.expiresAt < new Date()) return res.status(400).json({ message: "OTP expired"});

        if (user.otp.code !== otp) return res.status(400).json({
            message: "Invalid OTP"
        });

        user.otp = null;
        user.profile.verified = true;
        await user.save();

        const token = sign({ id: user._id });
        res.json({ user, token });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export async function forgotPassword(req, res) {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if(!user) return res.status(404).json({ message: "User not found" });

        const code = generateOtp(4);
        user.otp = { code, expiresAt: new Date(Date.now() + 10 + 60 + 1000) };

        await user.save();
        await sendOtpEmail(email, code);
        res.json({ message: "Reset OTP sent to email "});

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export async function resetPassword(req, res) {
   try {
     const { email, otp, newPassword } = req.body;

    const user = await User.findOne({ email });
    if ( !user || !user.otp ) {
        return res.status(400).json({
            message: " OTP not found"
        });
    }

    // if (user.otp.expiresAt < new Date()) return res.status(400).json({ message: "OTP expired" });
    if (user.otp.code !== otp) return res.status(400).json({ message: "Invalid OTP" });
    user.passwordHash = await bcrypt.hash( newPassword, 10);

    user.otp.code = null;
    await user.save();
    res.json({ message: "Password reset"});
   } catch (error) {
    res.status(500).json({ message: error.message });
   }

}

// Clerk login route: when frontend sends verified Clerk JWT, this endpoint created/fetches user
export async function clerkLogin(req, res) {
    try {
        const { clerkUserId, email, name } = req.body; // Frontend should send basic propfile after Clerk verifies

        if( !clerkUserId ) return res.status(400).json({ message: "clerkUserId required" });

        let user = await User.findOne({ clerkId: clerkUserId });

        if( !user ) {
            // If email exists, attach clerkId to existing user
            if(email) {
                user = await User.findOne({ email });
            }
            if(user) {
                user.clerkUd = clerkUserId;
                await user.save();
            } else {
                const tag = `player_${crypto.randomBytes(3).toString('hex')}`;

                user = await User.create({
                    clerkId: clerkUserId,
                    email,
                    profile: { nickname: name || "Player" },
                    "stats.userIdTag": tag
                });
            }
        }
        const token = sign({ id: user._id });
        res.json({ user, token });
    } catch (error) {
     res.status(500).json({ message: error.message });
       
    }
}