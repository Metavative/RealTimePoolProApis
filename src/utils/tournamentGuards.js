// utils/tournamentGuards.js

export function assertEntriesOpen(tournament) {
    if (!tournament) {
      const err = new Error("Tournament not found");
      err.statusCode = 404;
      throw err;
    }
    if (String(tournament.entriesStatus || "").toUpperCase() === "CLOSED") {
      const err = new Error("Entries are closed for this tournament");
      err.statusCode = 403;
      throw err;
    }
  }
  
  export function isInviteOnly(tournament) {
    return String(tournament.accessMode || "").toUpperCase() === "INVITE_ONLY";
  }
  
  export function normalizeModeAndStatus(tournament) {
    // Safe defaults (in case older tournaments missing fields)
    if (!tournament.accessMode) tournament.accessMode = "OPEN";
    if (!tournament.entriesStatus) tournament.entriesStatus = "OPEN";
    return tournament;
  }
  