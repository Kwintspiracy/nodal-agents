// format-time.ts — shared date/time formatting helpers.
//
// Extracted from 8 divergent copies (NotificationsBell, ChatClient, WebhookRow,
// MemoriesClient, RunsTable, jobs/[id]/page, CredentialsTable, ConnectorForm) —
// each had its own relativeTime/formatDate/truncate/expiry logic with slightly
// different null handling and thresholds. This is the single source of truth.
//
// Semantics chosen (richest of the originals, per audit): relativeTime uses
// ChatClient's "just now" / "yesterday" wording; every function returns '—'
// for a null/undefined input (some originals returned '', 'Never', or '').
// Used from both client components and a server component (jobs/[id]/page.tsx)
// — no 'use client' directive, these are plain pure functions.

type DateInput = Date | string | null | undefined;

function toDate(date: Date | string): Date {
  return typeof date === 'string' ? new Date(date) : date;
}

/**
 * Human-relative time: "just now" (<60s), "Xm ago", "Xh ago", "yesterday",
 * "Xd ago" (<7d), else a short locale date ("Jul 12"). Null/undefined → '—'.
 */
export function relativeTime(date: DateInput): string {
  if (!date) return '—';
  const d = toDate(date);
  const diffMs = Date.now() - d.getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Absolute date + time, locale-formatted ("Jul 19, 2026, 02:32 PM").
 * Null/undefined → '—'.
 */
export function formatDate(date: DateInput): string {
  if (!date) return '—';
  const d = toDate(date);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Truncates `s` to `n` characters, appending an ellipsis when it overflows. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Token/credential expiry, relative to now: "expires in X" / "expired X ago"
 * (seconds / minutes / hours / days, whichever is coarsest without rounding
 * to 0). Null/undefined → '—'.
 */
export function formatExpiry(date: DateInput): string {
  if (!date) return '—';
  const d = toDate(date);
  const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const magnitude =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)} min`
        : abs < 86400
          ? `${Math.round(abs / 3600)} h`
          : `${Math.round(abs / 86400)} d`;
  return diffSec >= 0 ? `expires in ${magnitude}` : `expired ${magnitude} ago`;
}

/** Whether `date` is in the past. Null/undefined → not expired. */
export function isExpired(date: DateInput): boolean {
  if (!date) return false;
  return toDate(date).getTime() < Date.now();
}
