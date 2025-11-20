import crypto from "crypto"
import dotenv from "dotenv"
dotenv.config();

// NOTE: THIS is a placeholder. Use official SDK docs for proper token format.
export function generateZegoToken(userId, roomId) {
    const appId = process.env.ZEGO_APP_ID;
    const secret = process.env.ZEGO_SERVER_SECRET;

    if( !appId || !secret ) throw new Error(" Zego env missing ");

    const payload = { appId, userId, roomId, ts: Date.now() };

    const token = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
    return { token, payload };
}