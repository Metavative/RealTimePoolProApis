import express from  "express"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { generateZegoToken } from "../services/zegoService.js";


const router = express.Router();

router.post("/token", authMiddleware, ( req,res ) => {
    const { roomId } = req.body;
    try {
        const { token, payload } = generateZegoToken(req.userId, roomId || "default_room");

        res.json({ token , payload });
    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }
})

export default router;