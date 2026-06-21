// timezone.ts — shared timezone helpers (pure, no DB).
// The workspace timezone (entities.timezone) is authoritative for scheduling +
// "what time is it" reasoning. When unset, fall back to the server's resolved
// zone. Centralised here so the runner deployment context and the schedule tools
// agree on the same resolution.

/** The server/process IANA timezone (the machine the runner runs on). */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Validate an IANA timezone name (e.g. "Europe/Paris"). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective timezone: the stored workspace zone if valid, else the
 * server's. Always returns a usable IANA name.
 */
export function resolveTimezone(stored: string | null | undefined): string {
  if (stored && isValidTimezone(stored)) return stored;
  return serverTimezone();
}

/** Human-readable current local time in a timezone, e.g. "Mon 20 Jun 2026, 14:05". */
export function formatLocalTime(tz: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString();
  }
}
