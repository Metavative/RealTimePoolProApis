// Minimal Clerk verify example: frontend should send Clerk JWT in header 'x-clerk-jwt'.
// For production use official Clerk SDK and server-side verification.


import {  } from "";
import { Clerk } from "@clerk/clerk-sdk-node";

const clerk = new Clerk ({ secretKey: process.env.CLERK_API_KEY });

export async function clerkAuth( req,res, next  ) {
    try {
        const token = req.headers["authorization"]?.split(" ")[1] || req.headers["x-clerk-auth"];

        if(!token) return res.status(401).json({ message: "Missing Clerk token" });

        const session = await clerk.verifyToken(token); // Clerk SDK method may differ; check docs

        req.clerkUserId = session?.sub || session?.userId || session?.id;
    } catch (err) {
        console.log("clerk verify error", err?.message || err );
        return res.status(401).json({ message: "Invalid clerk token" });
    }
}