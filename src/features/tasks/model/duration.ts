const UNKNOWN = "—";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Compact duration for the Tasks panel. Seconds are shown only while running;
 * finished work rounds down to whole minutes. Unknown or invalid input is a dash.
 */
export function formatDuration(ms: number | undefined, running: boolean): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return UNKNOWN;

  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  const minutes = Math.floor(ms / MINUTE_MS);
  if (!running) return minutes < 1 ? "<1m" : `${minutes}m`;

  if (minutes >= 10) return `${minutes}m`;
  const seconds = Math.floor((ms % MINUTE_MS) / 1000);
  return minutes < 1 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}
