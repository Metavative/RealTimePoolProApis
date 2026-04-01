function cleanString(v, fallback = "") {
  return String(v ?? fallback).trim();
}

function boolFromEnv(name, fallback = false) {
  const raw = cleanString(process.env[name], fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function numFromEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export async function v2FeatureStatus(req, res) {
  return res.json({
    ok: true,
    v2: {
      payments: {
        enabled: boolFromEnv("FEATURE_PAYMENTS_V2", false),
        provider: cleanString(process.env.PAYMENTS_PROVIDER || "MOCK").toUpperCase(),
        environment: cleanString(process.env.PAYMENTS_ENVIRONMENT || "SANDBOX").toUpperCase(),
      },
      storeCheckout: {
        enabled: boolFromEnv("FEATURE_STORE_CHECKOUT_V2", false),
      },
      levelEconomy: {
        enabled: boolFromEnv("FEATURE_LEVEL_ECONOMY_V2", false),
        maxLevel: numFromEnv("LEVEL_MAX_SUPPORTED", 20),
      },
      matchmaking: {
        enabled: boolFromEnv("FEATURE_MATCHMAKING_V2", false),
      },
      tournamentEconomy: {
        enabled: boolFromEnv("FEATURE_TOURNAMENT_ECONOMY_V2", false),
      },
      referral: {
        enabled: boolFromEnv("FEATURE_REFERRAL_V2", false),
      },
      dispute: {
        enabled: boolFromEnv("FEATURE_DISPUTE_V2", false),
      },
      insights: {
        enabled: boolFromEnv("FEATURE_INSIGHTS_V2", false),
      },
      achievements: {
        enabled: boolFromEnv("FEATURE_ACHIEVEMENTS_V2", false),
      },
    },
    serverTimeMs: Date.now(),
  });
}
