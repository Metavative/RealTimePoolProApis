import { v2 as cloudinary } from "cloudinary";

// True only when all three Cloudinary credentials are present. Exported so upload
// paths can fail fast with a clear message instead of a cryptic provider error.
export function isCloudinaryConfigured() {
  return Boolean(
    String(process.env.CLOUDINARY_NAME || "").trim() &&
      String(process.env.CLOUDINARY_API_KEY || "").trim() &&
      String(process.env.CLOUDINARY_SECRET_KEY || "").trim()
  );
}

// Configure Cloudinary at boot. Previously this logged "connected" unconditionally
// — even with no credentials — which made a misconfigured deployment look healthy
// while every image upload failed at runtime. Now it: (1) warns loudly and skips
// setup when unconfigured (non-fatal: the app still runs, uploads just return a
// clear 502), and (2) when configured, verifies the credentials with a ping so a
// wrong key is caught at startup instead of on the first user upload.
const connectCloudinary = async () => {
  if (!isCloudinaryConfigured()) {
    console.warn(
      "⚠️  Cloudinary is NOT configured (CLOUDINARY_NAME / CLOUDINARY_API_KEY / " +
        "CLOUDINARY_SECRET_KEY missing). Image uploads (avatars, etc.) will fail " +
        "until these are set."
    );
    return;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_SECRET_KEY,
  });

  try {
    await cloudinary.api.ping();
    // Plain string — don't depend on the `colors` String.prototype patch being
    // loaded first (it prints "undefined" if this runs before colors is imported).
    console.log("✅ Cloudinary is connected");
  } catch (err) {
    // Non-fatal: don't block boot, but make a bad credential obvious.
    console.error(
      "❌ Cloudinary credentials are set but the ping failed — check the values. " +
        (err?.message || err)
    );
  }
};

export default connectCloudinary;
