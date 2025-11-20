import Club from "../models/club.model.js";
import Booking from "../models/booking.modal.js";

export async function createClub(req,res) {
    try {
        const payload = req.body;
        const club = await Club.create({ ...payload, owner: req.userId });
        
        res.json({ club });
    } catch (error) {
        res.status(500).json({
            message: error.message,
        })
    }
}

export async function listNearby (req, res) {
    try {
        const { lng, lat, km = 10 } = req.query;
        
        const maxDistance = ( km || 10 ) * 1000;
        
        const clubs = await Club.find({
            location: {
                $near: {
                    $geometry: { type: "Point", coordinated: [ parseFloat(lng), parseFloat(lat) ] },
                    $maxDistance: maxDistance
                }
            }
        }).limit(50);
        res.json({ clubs })

    } catch (error) {
        res.status(500).json( {
            message: error.message,
        } )
    }
}

// ========= C R E A T E  B O O K I N G ========
export async function createBooking(req, res) {
    try {
        const { clubId, start, end } = req.body;
        const booking = await Booking.create({
            club: clubId,
            user: req.userId,
            slot: { start: new Date(start), end: new Date(end)},
            status: "pending"
        });
        // Ideally notify club owner via sockets
        res.json({ booking })
    
    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }
}