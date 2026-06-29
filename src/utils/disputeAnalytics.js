// Pure, dependency-free helpers for admin dispute-trend analytics. Kept side
// of effects out (no DB, no clock reads beyond the injected `now`) so they can
// be unit-tested deterministically. The admin controller fetches the dispute
// cases and passes them in.

const TERMINAL_STATUSES = ["RESOLVED", "REJECTED", "CANCELLED"];

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(date) {
  // UTC YYYY-MM-DD so buckets are stable regardless of server timezone.
  return date.toISOString().slice(0, 10);
}

function inc(map, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = (map[k] || 0) + 1;
}

/**
 * Summarize a set of dispute cases into trend metrics.
 *
 * @param {Array} cases  Dispute docs (lean) with createdAt, status, module,
 *                       claimedAmountMinor, resolution.{resolvedAt,decision,payoutAmountMinor}.
 * @param {Object} opts
 * @param {Date|number|string} opts.now        Reference "now" (required for a stable series).
 * @param {number} opts.windowDays             Series length in days (default 30).
 * @returns {Object} trend summary
 */
export function summarizeDisputeTrends(cases, { now, windowDays = 30 } = {}) {
  const rows = Array.isArray(cases) ? cases : [];
  const nowDate = toDate(now) || toDate(rows[0]?.createdAt) || new Date(0);
  const win = Math.max(1, Math.min(365, Math.floor(Number(windowDays) || 30)));

  const byStatus = {};
  const byModule = {};
  const byDecision = {};

  let resolved = 0;
  let openCount = 0;
  let claimedMinorTotal = 0;
  let payoutMinorTotal = 0;
  let resolutionHoursSum = 0;
  let resolutionHoursCount = 0;

  // Pre-seed the daily series so empty days still appear (newest last).
  const series = [];
  const seriesIndex = {};
  for (let i = win - 1; i >= 0; i--) {
    const d = new Date(nowDate.getTime() - i * 86400000);
    const key = dayKey(d);
    const entry = { date: key, opened: 0, resolved: 0 };
    seriesIndex[key] = entry;
    series.push(entry);
  }

  for (const c of rows) {
    const status = String(c?.status || "OPEN").toUpperCase();
    inc(byStatus, status);
    inc(byModule, c?.module);

    if (!TERMINAL_STATUSES.includes(status)) openCount += 1;

    claimedMinorTotal += Math.max(0, Math.floor(Number(c?.claimedAmountMinor) || 0));

    const created = toDate(c?.createdAt);
    if (created) {
      const k = dayKey(created);
      if (seriesIndex[k]) seriesIndex[k].opened += 1;
    }

    const res = c?.resolution || {};
    const resolvedAt = toDate(res?.resolvedAt);
    if (status === "RESOLVED") {
      resolved += 1;
      inc(byDecision, res?.decision || "NO_FAULT");
      payoutMinorTotal += Math.max(0, Math.floor(Number(res?.payoutAmountMinor) || 0));
      if (resolvedAt) {
        const k = dayKey(resolvedAt);
        if (seriesIndex[k]) seriesIndex[k].resolved += 1;
        if (created) {
          const hours = (resolvedAt.getTime() - created.getTime()) / 3600000;
          if (hours >= 0) {
            resolutionHoursSum += hours;
            resolutionHoursCount += 1;
          }
        }
      }
    }
  }

  const total = rows.length;
  const resolutionRatePct = total > 0 ? Math.round((resolved / total) * 1000) / 10 : 0;
  const avgResolutionHours =
    resolutionHoursCount > 0
      ? Math.round((resolutionHoursSum / resolutionHoursCount) * 10) / 10
      : null;

  return {
    total,
    open: openCount,
    resolved,
    resolutionRatePct,
    avgResolutionHours,
    byStatus,
    byModule,
    byDecision,
    claimedMinorTotal,
    payoutMinorTotal,
    windowDays: win,
    series,
  };
}
