/**
 * Shared text helpers of the interface (docs/ARCHITECTURE.md, "Frontend"): English plurals, relative time, the date
 * formats, the wait of a 429 and the failure texts several screens share. The interface has one language; dates are day
 * first with a 24-hour clock (en-GB).
 */

/** "1 change", "3 changes", "0 changes". */
export function countLabel(count: number, one: string, other: string): string {
  return `${count} ${Math.abs(count) === 1 ? one : other}`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Relative time, e.g. "12 minutes ago", "yesterday", "last week". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) {
    return 'just now';
  }
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600]
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [candidate, candidateSize] of units) {
    if (abs >= candidateSize) {
      unit = candidate;
      size = candidateSize;
    }
  }
  return relative.format(Math.round(seconds / size), unit);
}

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

/** "14:03"; '' for an invalid date. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : time.format(date);
}

/** "05/10/2026, 14:03"; the input itself for an invalid date. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/**
 * The wait from `Retry-After`, rounded up, with the sentence's full stop: "30 s." below a minute, "15 min." below an
 * hour, "24 h." otherwise. Abbreviations need no plural forms.
 */
function formatWait(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} s.`;
  }
  if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)} min.`;
  }
  return `${Math.ceil(seconds / 3600)} h.`;
}

/** Milliseconds as "24:13", or "1:05:00" from an hour, with the seconds rounded up. */
export function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** "Too many attempts. Try again in 30 s." with a wait, "Too many attempts. Try again later." without one (0 counts as none). */
export function tooManyAttempts(retryAfterSeconds: number | null | undefined): string {
  return retryAfterSeconds
    ? `Too many attempts. Try again in ${formatWait(retryAfterSeconds)}`
    : 'Too many attempts. Try again later.';
}

export const NO_CONNECTION = 'No connection to the server.';

export const PASSKEYS_AT_DOMAIN_ONLY = "Passkeys work only at the portal's domain name.";
