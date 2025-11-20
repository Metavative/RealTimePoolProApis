import Bookinng from "../models/booking.modal.js"

// ============= L I S T  O F  B O O K I N G S  =========
export async function listBookings(req, res) {
    try {
        const bookings = await Bookinng.find({
            user: req.userId
        }).populate("club");

        res.json({ bookings });
    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }
}

// ========== C A N C E L  B O O K I N G ==========
export async function cancelBooking(req, res) {
    try {
        
        const { bookingId } = req.body;
        const b = await Bookinng.findById( bookingId );

        if( !b ) return res.status(404).json({
            message: "Not found"
        });

        b.status = "cancelled";
        await b.save();
        res.json({ b });

    } catch (error) {
        res.status(500).json({
           message: error.message
        })
    }
}