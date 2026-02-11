export function rankToBaseScore(rank) {
    const r = String(rank || "").toLowerCase();
    if (r.includes("pro")) return 400;
    if (r.includes("advanced")) return 300;
    if (r.includes("intermediate")) return 200;
    return 100; // beginner/default
  }
  
  export function computeUserRating(user) {
    const score = Number(user?.stats?.score ?? 0);
    const winnings = Number(user?.stats?.totalWinnings ?? 0);
    const streak = Number(user?.stats?.bestWinStreak ?? 0);
  
    const base = score > 0 ? score : rankToBaseScore(user?.stats?.rank);
  
    // Small stable tie-breaks (don’t blow up rating)
    const winBoost = Math.min(50, winnings / 100);
    const streakBoost = Math.min(30, streak * 2);
  
    return Math.round(base + winBoost + streakBoost);
  }
  