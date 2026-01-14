import Club from "../models/club.model.js";
import Booking from "../models/booking.modal.js";

export async function createClub(req, res) {
  try {
    const payload = req.body;
    const club = await Club.create({ ...payload, owner: req.userId });
    res.json({ club });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
}

export async function listNearby(req, res) {
  try {
    const { lng, lat, km = 10 } = req.query;

    const maxDistance = (Number(km) || 10) * 1000;

    const lngNum = parseFloat(lng);
    const latNum = parseFloat(lat);

    if (Number.isNaN(lngNum) || Number.isNaN(latNum)) {
      return res.status(400).json({ message: "lng and lat are required numbers" });
    }

    const clubs = await Club.find({
      location: {
        $near: {
          // ✅ FIX: "coordinated" -> "coordinates"
          $geometry: { type: "Point", coordinates: [lngNum, latNum] },
          $maxDistance: maxDistance,
        },
      },
    }).limit(50);

    res.json({ clubs });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
}

// ========= C R E A T E  B O O K I N G ========
export async function createBooking(req, res) {
  try {
    const { clubId, start, end } = req.body;

    if (!clubId || !start || !end) {
      return res.status(400).json({ message: "clubId, start, end are required" });
    }

    const booking = await Booking.create({
      club: clubId,
      user: req.userId,
      slot: { start: new Date(start), end: new Date(end) },
      status: "pending",
    });

    res.json({ booking });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
}

// ========= O R G A N I Z E R   V E R I F I C A T I O N  (STEP 3) ========
//
// POST /api/club/verification/documents
// Authorization: Bearer <token>
// form-data:
// - venue_name
// - venue_address
// - business_license (pdf)
export async function uploadVerificationDocuments(req, res) {
  try {
    const venueName = String(req.body.venue_name || req.body.venueName || "").trim();
const venueAddress = String(req.body.venue_address || req.body.venueAddress || "").trim();


    if (!venueName) {
      return res.status(400).json({ message: "venue_name is required" });
    }
    if (!venueAddress) {
      return res.status(400).json({ message: "venue_address is required" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "business_license PDF is required" });
    }

    // ✅ We received the file in memory: req.file.buffer
    // On Railway, you should store it somewhere persistent:
    // - Cloudinary (recommended) OR S3 OR your DB (GridFS)
    //
    // For now, we’ll acknowledge it and (optionally) attach metadata to a club.
    // This avoids schema guessing and lets Flutter flow succeed immediately.

    // OPTIONAL: If you want to associate to the owner's club without breaking schema:
    // const club = await Club.findOne({ owner: req.userId }).sort({ createdAt: -1 });
    // if (club) {
    //   club.verification = club.verification || {};
    //   club.verification.status = "pending";
    //   club.verification.venueName = venueName;
    //   club.verification.venueAddress = venueAddress;
    //   club.verification.businessLicense = {
    //     originalName: req.file.originalname,
    //     mimeType: req.file.mimetype,
    //     size: req.file.size,
    //   };
    //   await club.save();
    // }

    return res.json({
      success: true,
      message: "Verification documents received",
      venueName,
      venueAddress,
      file: {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
