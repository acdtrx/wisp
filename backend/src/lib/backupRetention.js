/**
 * Retention policy for scheduled container backups (GFS-lite):
 * keep the newest scheduled backup per calendar day for the last
 * `retainDays` days, plus the newest scheduled backup per ISO week for the
 * `retainWeeks` most recent weeks older than that daily window. Everything
 * else that is scheduled-origin is pruned.
 *
 * Manual backups — and backups predating the manifest `origin` field, which
 * list as 'manual' — are never returned for deletion.
 *
 * Weekly keeps are presence-based (the most recent N weeks that actually
 * have backups), not calendar-based: a gap in the schedule (host off,
 * scheduler disabled for a while) must not cause the only remaining old
 * backups to be deleted.
 *
 * Pure module: no imports, no I/O. Timestamps are the backup-dir form
 * `YYYY-MM-DDTHH-mm-ss` (UTC, from toISOString) so lexicographic order is
 * chronological and `slice(0, 10)` is the UTC day key.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-8601 week key (e.g. "2026-W28") for a `YYYY-MM-DD` UTC day key. */
function isoWeekKey(dayKey) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to this week's Thursday
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Compute which scheduled backups to delete for one container at one
 * destination.
 *
 * @param {Array<{ timestamp: string, origin?: string }>} backups - list rows
 *   (extra fields like `path` pass through untouched)
 * @param {{ retainDays: number, retainWeeks: number, now?: Date }} opts
 * @returns {Array<object>} subset of the input rows to DELETE
 */
export function computeScheduledBackupPruneList(backups, { retainDays, retainWeeks, now = new Date() }) {
  const scheduled = (Array.isArray(backups) ? backups : [])
    .filter((b) => b && b.origin === 'scheduled' && typeof b.timestamp === 'string')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first
  if (scheduled.length === 0) return [];

  const days = Number.isInteger(retainDays) && retainDays >= 1 ? retainDays : 7;
  const weeks = Number.isInteger(retainWeeks) && retainWeeks >= 0 ? retainWeeks : 0;

  /* Earliest UTC day still inside the daily window (today counts as day 1). */
  const dailyCutoff = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const keep = new Set();
  const seenDays = new Set();
  const seenWeeks = [];

  for (const b of scheduled) {
    const dayKey = b.timestamp.slice(0, 10);
    if (dayKey >= dailyCutoff) {
      /* Daily window: newest per day (first hit wins — list is newest-first). */
      if (!seenDays.has(dayKey)) {
        seenDays.add(dayKey);
        keep.add(b);
      }
    } else if (weeks > 0) {
      /* Older: newest per ISO week, for the most recent `weeks` weeks that
       * have backups. Weeks arrive in descending order because rows do. */
      const weekKey = isoWeekKey(dayKey);
      if (!seenWeeks.includes(weekKey)) {
        if (seenWeeks.length >= weeks) continue; // past the weekly window → prune
        seenWeeks.push(weekKey);
        keep.add(b);
      }
    }
  }

  return scheduled.filter((b) => !keep.has(b));
}
