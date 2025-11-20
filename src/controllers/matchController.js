import Match from "./../models/match.model.js";
import User from "./../models/user.model.js"; // Import Zaroori Hai
import Transaction from "./../models/transaction.model.js"; // Import Zaroori Hai
import mongoose from "mongoose"; // Session aur Transaction ke liye zaroori

// Commission Rate: App ka apna commission (e.g., 10%)
const APP_COMMISSION_RATE = 0.10; // 10% commission

// ========================
// 1. CREATE CHALLENGE
// ========================
export async function createChallenge(req, res) {
    try {
        const { opponentId, entryFee, clubId, slot } = req.body;
        const challenger = req.userId;

        // ✅ Sudhaar 1: MatchSchema mein 'players' array mein object IDs chahiye
        const match = await Match.create({
            players: [challenger, opponentId], // Array format mein theek kiya
            status: "pending",
            entryFee: entryFee || 0,
            meta: { clubId, slot }
        });

        // TODO: Socket.io se opponentId ko 'challenge:received' event bhejna.

        res.json({ match });

    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }
}

// ========================
// 2. ACCEPT CHALLENGE
// ========================
export async function acceptChallenge(req, res) {
    try {
        const { matchId } = req.body;
        const match = await Match.findById(matchId);
        
        if (!match) return res.status(404).json({ message: "Match not found" });

        match.status = "ongoing";
        match.startAt = new Date();
        await match.save();
        
        // TODO: Socket.io se challenger ko 'match:started' event bhejna.

        res.json({ match });

    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
}


// ========================
// 3. FINISH MATCH (CRITICAL LOGIC ADDED)
// ========================
export async function finishMatch(req, res) {
    // Transaction ki integrity ke liye Session zaroori hai
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { matchId, winnerId, scores } = req.body;
        
        const match = await Match.findById(matchId).session(session);
        if (!match) {
            await session.abortTransaction();
            return res.status(404).json({ message: "Match not found" });
        }

        // Match ki validation
        if (match.status !== "ongoing") {
             await session.abortTransaction();
             return res.status(400).json({ message: "Match is not ongoing." });
        }

        const loserId = match.players.find(p => p.toString() !== winnerId);
        if (!loserId) {
             await session.abortTransaction();
             return res.status(400).json({ message: "Invalid winner or players." });
        }

        const entryFee = match.entryFee;
        const totalWager = entryFee * 2;
        const appCommission = totalWager * APP_COMMISSION_RATE;
        const payoutAmount = totalWager - appCommission;

        // 1. Match ko Update karein
        match.status = "finished";
        match.endAt = new Date();
        match.winner = winnerId;
        match.score = scores;
        await match.save({ session });


        // 2. User Stats aur Earnings Update karein
        const winnerUpdate = {
            $inc: {
                "earnings.availableBalance": payoutAmount, // Winner ko payout milega
                "earnings.career": payoutAmount,
                "stats.totalWinnings": payoutAmount,
                "stats.totalWins": 1,
            }
        };

        const loserUpdate = {
            $inc: {
                "stats.totalLosses": 1, // Loser ka loss count badhega
            }
            // Loser ka entryFee pehle hi block ho chuka hoga
        };

        await User.findByIdAndUpdate(winnerId, winnerUpdate, { session });
        await User.findByIdAndUpdate(loserId, loserUpdate, { session });
        
        // **Zaroori Note:** EntryFee debit/credit logic yahan nahi hai. Hum yeh maan rahe hain 
        // ke 'entryFee' ki amount 'createChallenge' ya 'acceptChallenge' ke waqt user ke 
        // 'availableBalance' se 'locked/pending' state mein nikal li gayi thi.

        
        // 3. Transaction Records Create karein
        // A. Payout to Winner
        await Transaction.create([{
            user: winnerId,
            amount: payoutAmount,
            type: "payout",
            status: "completed",
            meta: { matchId: match._id, commission: appCommission }
        }], { session });

        // B. App Commission Record (Optional, lekin achi practice hai)
        await Transaction.create([{
            user: winnerId, // Ya app ka admin ID
            amount: appCommission,
            type: "debit", // Ya 'commission' agar Transaction model mein ho
            status: "completed",
            meta: { matchId: match._id, description: "App Commission" }
        }], { session });

        
        // Transaction ko commit karein
        await session.commitTransaction();
        session.endSession();

        // TODO: Socket.io se dono players ko 'match:finished' event aur result bhejna.
        
        res.json({ 
            message: "Match finished and funds settled successfully", 
            match, 
            payout: payoutAmount 
        });

    } catch (error) {
        // Agar koi bhi step fail hua to saari changes rollback ho jayengi
        await session.abortTransaction();
        session.endSession();
        console.error("Match Settlement Failed:", error);
        res.status(500).json({
            message: "Match settlement failed. Funds safe. Error: " + error.message
        });
    }
}


// ========================
// 4. CANCEL MATCH
// ========================
export async function cancelMatch(req, res) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { matchId } = req.body;
        const match = await Match.findById(matchId).session(session);

        if (!match) {
            await session.abortTransaction();
            return res.status(404).json({ message: "Match not found" });
        }

        // 1. Match status update
        match.status = "cancelled";
        await match.save({ session });

        // 2. Refund logic (Agar entryFee pehle hi nikal li gayi thi)
        const entryFee = match.entryFee;
        if (entryFee > 0) {
            for (const playerId of match.players) {
                // User ke availableBalance mein entryFee wapas karein
                await User.findByIdAndUpdate(playerId, {
                    $inc: { "earnings.availableBalance": entryFee }
                }, { session });

                // Refund Transaction record
                await Transaction.create([{
                    user: playerId,
                    amount: entryFee,
                    type: "refund",
                    status: "completed",
                    meta: { matchId: match._id, description: "Match Cancelled Refund" }
                }], { session });
            }
        }
        
        await session.commitTransaction();
        session.endSession();
        
        res.json({ message: "Match cancelled and funds refunded", match });
        
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({
            message: "Match cancellation failed. Error: " + error.message
        });
    }
}